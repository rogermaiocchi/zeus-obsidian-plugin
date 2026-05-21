import Foundation

#if os(iOS) && canImport(MLXLLM)
import MLX
import MLXLLM
import MLXLMCommon
#endif

// QwenProvider — motor generativo Qwen 2.5 3B-Instruct 4-bit para iOS on-device.
//
// Substituição do MLXGemmaTwinRunner (Gemma 4 E2B/E4B) pelo Qwen 2.5 3B-Instruct.
// Vantagens sobre Gemma 4 neste contexto:
//   • Único modelo para iPhone + iPad — elimina divisão E2B/E4B (~1.8 GB int4)
//   • Melhor desempenho em português do Brasil e text engineering multilíngue
//   • Saída JSON mais determinística (temperatura 0.0, stop tokens precisos)
//   • Menor uso de RAM em A14/A16 que Gemma 4 E4B (iPad), 4K contexto suficiente
//     para as 7 tarefas do plugin
//
// Chat template: ChatML (Qwen 2.5-Instruct padrão)
//   <|im_start|>system\n{prompt}<|im_end|>\n
//   <|im_start|>user\n{input}<|im_end|>\n
//   <|im_start|>assistant\n
//
// Treinamento / fine-tuning (Fase A → B):
//   • Fase A: few-shot puro (pares curados FewShotExamples/*.json) — stock weights
//   • Fase B: LoRA distillation (AegisTwinTrainer) sobre corpus PT-BR de:
//       semântica, léxico, morfologia, fonologia, coesão/coerência, anáfora/catáfora,
//       concordância verbal, métodos Feynman/Luhmann/Cornell, busca hash turbo quantico
//   Referência: domínio EXPLICITAMENTE não-jurídico — engenharia de texto e
//   arquitetura de busca semântica nativa para Obsidian.
//
// Modelo distribuído como On-Demand Resource (ODR) com tag "qwen-twin".
// Pesos: vault/data/zeus-qwen-3b-instruct/ (após instalação via ODR).
// Encapsulamento: prefixo zeus- (conforme regra de autonomia v1.15.0).

// MARK: - Runner concreto (compilado somente no build iOS)

#if os(iOS) && canImport(MLXLLM)

public final class MLXQwenRunner: MLXAppleTwinProviding, @unchecked Sendable {

    private let modelURL: URL
    private let systemPrompt: String
    private let loadQueue = DispatchQueue(
        label: "org.maiocchi.aegis.qwen.loader", qos: .userInitiated)
    private var modelContainer: ModelContainer?
    private let loadGate = DispatchSemaphore(value: 1)

    public init(modelURL: URL, systemPrompt: String) {
        self.modelURL = modelURL
        self.systemPrompt = systemPrompt
        loadQueue.async { [weak self] in self?.ensureLoaded() }
    }

    private func ensureLoaded() {
        loadGate.wait()
        defer { loadGate.signal() }
        guard modelContainer == nil else { return }
        let factory = LLMModelFactory.shared
        let configuration = ModelConfiguration(directory: modelURL)
        let sem = DispatchSemaphore(value: 0)
        var container: ModelContainer?
        Task {
            do { container = try await factory.loadContainer(configuration: configuration) }
            catch { NSLog("[Qwen] load failed: \(error)") }
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + .seconds(120))
        if let c = container { self.modelContainer = c }
    }

    // MARK: - Política térmica

    private struct ThermalBudget {
        let maxTokens: Int
        let contextWindow: Int
        let temperature: Float
    }

    private func budget(requested maxTokens: Int) -> ThermalBudget {
        switch ProcessInfo.processInfo.thermalState {
        case .nominal, .fair:
            return ThermalBudget(maxTokens: maxTokens, contextWindow: 4096, temperature: 0.0)
        case .serious:
            return ThermalBudget(maxTokens: min(180, maxTokens), contextWindow: 1024, temperature: 0.0)
        case .critical:
            return ThermalBudget(maxTokens: 0, contextWindow: 0, temperature: 0.0)
        @unknown default:
            return ThermalBudget(maxTokens: min(180, maxTokens), contextWindow: 1024, temperature: 0.0)
        }
    }

    // MARK: - API genérica (compatível com runFoundationModel do handler)

    /// Interface genérica para o fallback MLX no AegisHTTPHandlers.
    /// Mapeia task name → few-shot + system prompt correto, assim o handler
    /// não precisa conhecer a estrutura interna do Qwen.
    public func runGeneric(
        instructions: String,
        prompt: String,
        maxTokens: Int,
        task: String,
        inlineExamples: [(input: String, output: String)] = []
    ) -> Result<String, Error> {
        let fewShotTask = FewShotTask(rawValue: task)
        let sysOverride = AppleTwinSystemPrompt.forCommandNamed(task) ?? instructions
        return runQwen(
            prompt,
            systemOverride: sysOverride,
            maxTokens: maxTokens,
            fewShotTask: fewShotTask,
            inlineExamples: inlineExamples.isEmpty ? nil : inlineExamples
        )
    }

    // MARK: - Inferência ChatML

    private func runQwen(
        _ userTurn: String,
        systemOverride: String? = nil,
        maxTokens: Int,
        fewShotTask: FewShotTask? = nil,
        inlineExamples: [(input: String, output: String)]? = nil
    ) -> Result<String, Error> {
        if ProcessInfo.processInfo.thermalState == .critical {
            return .failure(MLXAppleTwinError.thermalCritical)
        }
        ensureLoaded()
        guard let container = modelContainer else {
            return .failure(MLXAppleTwinError.modelNotLoaded)
        }

        let b = budget(requested: maxTokens)
        if b.maxTokens == 0 { return .failure(MLXAppleTwinError.thermalCritical) }

        let sys = systemOverride ?? systemPrompt

        // Few-shot: bundle (tarefa canônica) + vault-local inline (vault-specific, maior prioridade).
        // Ordem: bundle pares → inline pares → turno do usuário.
        // Inline exemplos vêm do FewShotCache.js (aprendizado contínuo on-device).
        let bundleFewShot = fewShotTask != nil ? FewShotLoader.renderTurnsQwen(fewShotTask!) : ""
        let inlineFewShot: String = (inlineExamples ?? []).prefix(3).map { ex in
            "<|im_start|>user\n\(ex.input)<|im_end|>\n<|im_start|>assistant\n\(ex.output)<|im_end|>\n"
        }.joined()
        let fewShot = bundleFewShot + inlineFewShot

        // Template ChatML — Qwen 2.5-Instruct padrão.
        let prompt = """
        <|im_start|>system
        \(sys)<|im_end|>
        \(fewShot)<|im_start|>user
        \(userTurn)<|im_end|>
        <|im_start|>assistant

        """

        let sem = DispatchSemaphore(value: 0)
        var result: Result<String, Error> = .failure(MLXAppleTwinError.timeoutReached)
        Task {
            do {
                let params = GenerateParameters(maxTokens: b.maxTokens, temperature: b.temperature)
                let output = try await container.perform { context in
                    let input = try await context.processor.prepare(input: .init(prompt: prompt))
                    let stream = try MLXLMCommon.generate(
                        input: input, parameters: params, context: context)
                    var collected = ""
                    for await chunk in stream {
                        if case .chunk(let t) = chunk { collected.append(t) }
                        // Stop em <|im_end|> — Qwen pode emitir antes do max_tokens.
                        if collected.contains("<|im_end|>") { break }
                    }
                    return collected
                }
                let cleaned = output
                    .components(separatedBy: "<|im_end|>").first?
                    .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                result = .success(cleaned)
            } catch {
                result = .failure(MLXAppleTwinError.generationFailed(error.localizedDescription))
            }
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + .seconds(120))
        return result
    }

    // MARK: - JSON parsing tolerante (idêntico ao Gemma runner)

    private func parseJSONObject(_ raw: String, taskTag: String) -> Result<[String: Any], Error> {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("```") { s = s.split(separator: "\n", maxSplits: 1).last.map(String.init) ?? s }
        if s.hasSuffix("```") { s = String(s.dropLast(3)) }
        if let start = s.firstIndex(of: "{"), let end = s.lastIndex(of: "}"), start < end {
            s = String(s[start...end])
        }
        guard let data = s.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return .failure(MLXAppleTwinError.generationFailed(
                "JSON inválido em \(taskTag): \(s.prefix(160))…"))
        }
        return .success(obj)
    }

    // MARK: - MLXAppleTwinProviding (7 funções — protocolo base, sem inline examples)

    public func prompt(instruction: String, maxTokens: Int, deterministic: Bool) -> Result<String, Error> {
        return runQwen(instruction, maxTokens: maxTokens, fewShotTask: .prompt)
    }

    public func summarize(text: String, maxTokens: Int) -> Result<String, Error> {
        return summarize(text: text, maxTokens: maxTokens, inlineExamples: [])
    }

    public func refine(text: String, instructions: String?, maxTokens: Int) -> Result<String, Error> {
        return refine(text: text, instructions: instructions, maxTokens: maxTokens, inlineExamples: [])
    }

    public func enrich(noteContent: String, notePath: String?) -> Result<[String: Any], Error> {
        return enrich(noteContent: noteContent, notePath: notePath, inlineExamples: [])
    }

    public func hyde(query: String, style: String, maxTokens: Int) -> Result<String, Error> {
        return hyde(query: query, style: style, maxTokens: maxTokens, inlineExamples: [])
    }

    public func agentQuery(question: String, context: [String], pattern: String) -> Result<String, Error> {
        return agentQuery(question: question, context: context, pattern: pattern, inlineExamples: [])
    }

    public func graphExtract(text: String, domain: String) -> Result<[String: Any], Error> {
        return graphExtract(text: text, domain: domain, inlineExamples: [])
    }

    // MARK: - Variantes com inline examples (aprendizado contínuo on-device)

    public func summarize(text: String, maxTokens: Int, inlineExamples: [(input: String, output: String)]) -> Result<String, Error> {
        let userTurn = "Sumarize o texto a seguir em prosa contínua, fiel ao original, no mesmo idioma:\n\n\(text)"
        return runQwen(
            userTurn,
            systemOverride: AppleTwinSystemPrompt.forCommand(.summarize),
            maxTokens: maxTokens,
            fewShotTask: .summarize,
            inlineExamples: inlineExamples.isEmpty ? nil : inlineExamples
        )
    }

    public func refine(text: String, instructions: String?, maxTokens: Int, inlineExamples: [(input: String, output: String)]) -> Result<String, Error> {
        let directive = instructions ?? "Reescreva mantendo o sentido, melhore clareza, gramática e fluidez. Mantenha o idioma."
        let userTurn = "[instruções: \(directive)]\n\(text)"
        return runQwen(
            userTurn,
            systemOverride: AppleTwinSystemPrompt.forCommand(.refine),
            maxTokens: maxTokens,
            fewShotTask: .refine,
            inlineExamples: inlineExamples.isEmpty ? nil : inlineExamples
        )
    }

    public func enrich(noteContent: String, notePath: String?, inlineExamples: [(input: String, output: String)]) -> Result<[String: Any], Error> {
        let userTurn = """
        Analise a nota a seguir e devolva APENAS um JSON estrito (sem fences, sem comentários) com:
          suggested_links: [{title, path, reason}]
          suggested_tags:  [string]
          connections:     [{title, path, reason}]

        Nota:
        \(noteContent)
        """
        switch runQwen(
            userTurn,
            systemOverride: AppleTwinSystemPrompt.forCommand(.enrich),
            maxTokens: 600,
            fewShotTask: .enrich,
            inlineExamples: inlineExamples.isEmpty ? nil : inlineExamples
        ) {
        case .failure(let e): return .failure(e)
        case .success(let raw): return parseJSONObject(raw, taskTag: "enrich")
        }
    }

    public func hyde(query: String, style: String, maxTokens: Int, inlineExamples: [(input: String, output: String)]) -> Result<String, Error> {
        let userTurn = "[style: \(style)]\n\(query)"
        return runQwen(
            userTurn,
            systemOverride: AppleTwinSystemPrompt.forCommand(.hyde),
            maxTokens: maxTokens,
            fewShotTask: .hyde,
            inlineExamples: inlineExamples.isEmpty ? nil : inlineExamples
        )
    }

    public func agentQuery(question: String, context: [String], pattern: String, inlineExamples: [(input: String, output: String)]) -> Result<String, Error> {
        var blob: [String: Any] = ["question": question, "pattern": pattern]
        if !context.isEmpty { blob["context"] = context }
        let json = (try? JSONSerialization.data(withJSONObject: blob, options: [.prettyPrinted]))
            .flatMap { String(data: $0, encoding: .utf8) } ?? question
        return runQwen(
            json,
            systemOverride: AppleTwinSystemPrompt.forCommand(.agent_query),
            maxTokens: 700,
            fewShotTask: .agent_query,
            inlineExamples: inlineExamples.isEmpty ? nil : inlineExamples
        )
    }

    public func graphExtract(text: String, domain: String, inlineExamples: [(input: String, output: String)]) -> Result<[String: Any], Error> {
        let blob: [String: Any] = ["text": text, "domain": domain]
        let json = (try? JSONSerialization.data(withJSONObject: blob, options: [.prettyPrinted]))
            .flatMap { String(data: $0, encoding: .utf8) } ?? text
        switch runQwen(
            json,
            systemOverride: AppleTwinSystemPrompt.forCommand(.graph_extract),
            maxTokens: 700,
            fewShotTask: .graph_extract,
            inlineExamples: inlineExamples.isEmpty ? nil : inlineExamples
        ) {
        case .failure(let e): return .failure(e)
        case .success(let raw): return parseJSONObject(raw, taskTag: "graph_extract")
        }
    }
}

#endif // os(iOS) && canImport(MLXLLM)
