import Foundation

#if os(iOS) && canImport(MLXLLM)
import MLX
import MLXLLM
import MLXLMCommon
#endif

// MLXAppleTwinProvider — runtime LLM embarcado no AegisDaemon iOS.
//
// Decisão arquitetural (Zeus / on-device puro):
//   • Macs (mini + MacBook): FoundationModels nativos da Apple. Twin NUNCA é usado.
//   • iOS (iPhone + iPad): runtime MLX Swift carregando Gemma 4 fine-tunado
//     ("Apple-Twin") quando Apple Intelligence não está elegível ou indisponível.
//     100% offline, zero rede no caminho de inferência.
//
// Variantes deployadas:
//   • iPhone (8GB+ RAM, 15 Pro / 16 / 17): gemma-4-e2b-apple-twin-q4-mlx (~1.4 GB)
//   • iPad M-series:                       gemma-4-e4b-apple-twin-q4-mlx (~2.6 GB)
//   • iPhone 6GB legado:                   E2B com contexto reduzido para 4K + Q3
//
// Bundling:
//   Os pesos vão como On-Demand Resource (ODR) tagueados como `gemma-twin`,
//   baixados na primeira execução (evita binário do app gigante).
//
// Política térmica:
//   Watchdog `ProcessInfo.thermalState`:
//     .nominal/.fair    → contexto cheio (8192 tokens), gerador normal
//     .serious          → throttle: contexto 1024, max 200 tokens, temp 0.0
//     .critical         → recusa geração e retorna fallback minimalista
//

// Fase 2 parity (v1.0.0-fase2-parity): cobertura completa das 7 funções generativas
// que o FoundationModels do Mac mini/MacBook executa. Cada método tem a MESMA
// assinatura semântica do equivalente Apple, para que o caller (handlers HTTP)
// permaneça agnóstico ao provedor.

public protocol MLXAppleTwinProviding {

    /// Prompt livre (equivalente a `LanguageModelSession.respond(to:)`).
    func prompt(instruction: String, maxTokens: Int, deterministic: Bool) -> Result<String, Error>

    /// Sumarização em prosa contínua.
    func summarize(text: String, maxTokens: Int) -> Result<String, Error>

    /// Writing Tools / afm-refine — reescrita, ajuste de tom, expansão/condensação.
    func refine(text: String, instructions: String?, maxTokens: Int) -> Result<String, Error>

    /// Enrichment estruturado de nota Obsidian (JSON estrito).
    func enrich(noteContent: String, notePath: String?) -> Result<[String: Any], Error>

    /// HyDE — gera doc hipotético para melhorar retrieval.
    func hyde(query: String, style: String, maxTokens: Int) -> Result<String, Error>

    /// Agent Q&A com contexto opcional (RAG).
    func agentQuery(question: String, context: [String], pattern: String) -> Result<String, Error>

    /// Extração de grafo (entidades + relações) — JSON estrito.
    func graphExtract(text: String, domain: String) -> Result<[String: Any], Error>
}

public enum MLXAppleTwinProvider {
    /// Provider concreto wired no startup do daemon iOS. `nil` no macOS (Apple Intelligence cobre).
    public static var shared: MLXAppleTwinProviding?
}

public enum MLXAppleTwinError: LocalizedError {
    case modelNotLoaded
    case generationFailed(String)
    case quantizationMismatch
    case timeoutReached
    case thermalCritical

    public var errorDescription: String? {
        switch self {
        case .modelNotLoaded:         return "Modelo MLX Gemma 4 Apple-Twin não carregado em memória."
        case .generationFailed(let m): return "Geração MLX falhou: \(m)"
        case .quantizationMismatch:   return "Quantização do modelo incompatível com runtime MLX deste device."
        case .timeoutReached:         return "Geração MLX excedeu o tempo limite de 120s."
        case .thermalCritical:        return "Dispositivo em thermalState .critical — geração recusada para preservar hardware."
        }
    }
}

// MARK: - Implementação concreta (compilada apenas no build iOS)

#if os(iOS) && canImport(MLXLLM)

/// Runner concreto que envolve MLXLLM (ml-explore/mlx-swift-examples).
public final class MLXGemmaTwinRunner: MLXAppleTwinProviding, @unchecked Sendable {

    private let modelURL: URL
    private let systemPrompt: String
    private let loadQueue = DispatchQueue(label: "org.maiocchi.aegis.mlx.loader", qos: .userInitiated)
    private var modelContainer: ModelContainer?
    private let loadGate = DispatchSemaphore(value: 1)

    public init(modelURL: URL, systemPrompt: String) {
        self.modelURL = modelURL
        self.systemPrompt = systemPrompt
        // Eager load: carrega pesos em background para não bloquear primeira chamada.
        loadQueue.async { [weak self] in self?.ensureLoaded() }
    }

    private func ensureLoaded() {
        loadGate.wait()
        defer { loadGate.signal() }
        guard modelContainer == nil else { return }
        do {
            // ModelFactory.loadContainer espera um diretório com config.json + tokenizer + weights*.safetensors
            let factory = LLMModelFactory.shared
            let configuration = ModelConfiguration(directory: modelURL)
            // Bloqueante via semáforo — eager-load roda em background queue
            let sem = DispatchSemaphore(value: 0)
            var container: ModelContainer?
            var loadError: Error?
            Task {
                do {
                    container = try await factory.loadContainer(configuration: configuration)
                } catch {
                    loadError = error
                }
                sem.signal()
            }
            _ = sem.wait(timeout: .now() + .seconds(120))
            if let container { self.modelContainer = container }
            else if let loadError { NSLog("MLX load failed: \(loadError)") }
        }
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
            return ThermalBudget(maxTokens: maxTokens, contextWindow: 8192, temperature: 0.0)
        case .serious:
            return ThermalBudget(maxTokens: min(200, maxTokens), contextWindow: 1024, temperature: 0.0)
        case .critical:
            return ThermalBudget(maxTokens: 0, contextWindow: 0, temperature: 0.0) // refused
        @unknown default:
            return ThermalBudget(maxTokens: min(200, maxTokens), contextWindow: 1024, temperature: 0.0)
        }
    }

    // MARK: - Inferência

    private func runMLX(_ userTurn: String, maxTokens: Int, fewShotTask: FewShotTask? = nil) -> Result<String, Error> {
        if ProcessInfo.processInfo.thermalState == .critical {
            return .failure(MLXAppleTwinError.thermalCritical)
        }
        ensureLoaded()
        guard let container = modelContainer else {
            return .failure(MLXAppleTwinError.modelNotLoaded)
        }

        let b = budget(requested: maxTokens)
        if b.maxTokens == 0 {
            return .failure(MLXAppleTwinError.thermalCritical)
        }

        // Fase A — few-shot prompting. Prepend exemplos curados (Apple-style)
        // antes do turno do usuário, ancorando o tom e o formato da resposta.
        let fewShot = (fewShotTask != nil) ? FewShotLoader.renderTurns(fewShotTask!) : ""

        let prompt = """
        <start_of_turn>user
        \(systemPrompt)<end_of_turn>
        <start_of_turn>model
        Entendido. Vou responder no estilo Apple Intelligence: institucional, sóbrio, direto, sem emojis.<end_of_turn>
        \(fewShot)<start_of_turn>user
        \(userTurn)<end_of_turn>
        <start_of_turn>model

        """

        let sem = DispatchSemaphore(value: 0)
        var result: Result<String, Error> = .failure(MLXAppleTwinError.timeoutReached)
        Task {
            do {
                let params = GenerateParameters(
                    maxTokens: b.maxTokens,
                    temperature: b.temperature
                )
                let output = try await container.perform { context in
                    let input = try await context.processor.prepare(input: .init(prompt: prompt))
                    let stream = try MLXLMCommon.generate(
                        input: input,
                        parameters: params,
                        context: context
                    )
                    var collected = ""
                    for await chunk in stream {
                        if case .chunk(let t) = chunk { collected.append(t) }
                    }
                    return collected
                }
                let cleaned = output
                    .replacingOccurrences(of: "<end_of_turn>", with: "")
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                result = .success(cleaned)
            } catch {
                result = .failure(MLXAppleTwinError.generationFailed(error.localizedDescription))
            }
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + .seconds(120))
        return result
    }

    // MARK: - Protocolo

    // MARK: - Helpers de parsing JSON tolerante

    private func parseJSONObject(_ raw: String, taskTag: String) -> Result<[String: Any], Error> {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("```") {
            s = s.split(separator: "\n", maxSplits: 1).last.map(String.init) ?? s
        }
        if s.hasSuffix("```") {
            s = String(s.dropLast(3))
        }
        // Tenta delimitar pelo primeiro { e último } caso o modelo coloque preâmbulo.
        if let start = s.firstIndex(of: "{"), let end = s.lastIndex(of: "}"), start < end {
            s = String(s[start...end])
        }
        guard let data = s.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return .failure(MLXAppleTwinError.generationFailed(
                "JSON inválido em \(taskTag): \(s.prefix(160))…"
            ))
        }
        return .success(obj)
    }

    // MARK: - Protocolo (7 funções) — todos com few-shot da Fase A

    public func prompt(instruction: String, maxTokens: Int, deterministic: Bool) -> Result<String, Error> {
        return runMLX(instruction, maxTokens: maxTokens, fewShotTask: .prompt)
    }

    public func summarize(text: String, maxTokens: Int) -> Result<String, Error> {
        let userTurn = """
        Sumarize o texto a seguir em prosa contínua, fiel ao original, no mesmo idioma:

        \(text)
        """
        return runMLX(userTurn, maxTokens: maxTokens, fewShotTask: .summarize)
    }

    public func refine(text: String, instructions: String?, maxTokens: Int) -> Result<String, Error> {
        let directive = instructions ?? "Reescreva mantendo o sentido, melhore clareza, gramática e fluidez. Mantenha o idioma."
        let userTurn = """
        [instruções: \(directive)]
        \(text)
        """
        return runMLX(userTurn, maxTokens: maxTokens, fewShotTask: .refine)
    }

    public func enrich(noteContent: String, notePath: String?) -> Result<[String: Any], Error> {
        let userTurn = """
        Analise a nota a seguir e devolva APENAS um JSON estrito (sem fences, sem comentários) com:
          suggested_links: [{title, path, reason}]
          suggested_tags:  [string]
          connections:     [{title, path, reason}]

        Nota:
        \(noteContent)
        """
        switch runMLX(userTurn, maxTokens: 600, fewShotTask: .enrich) {
        case .failure(let e): return .failure(e)
        case .success(let raw): return parseJSONObject(raw, taskTag: "enrich")
        }
    }

    public func hyde(query: String, style: String, maxTokens: Int) -> Result<String, Error> {
        let userTurn = """
        [style: \(style)]
        \(query)
        """
        return runMLX(userTurn, maxTokens: maxTokens, fewShotTask: .hyde)
    }

    public func agentQuery(question: String, context: [String], pattern: String) -> Result<String, Error> {
        var blob: [String: Any] = ["question": question, "pattern": pattern]
        if !context.isEmpty { blob["context"] = context }
        let json = (try? JSONSerialization.data(withJSONObject: blob, options: [.prettyPrinted]))
            .flatMap { String(data: $0, encoding: .utf8) } ?? question
        return runMLX(json, maxTokens: 700, fewShotTask: .agent_query)
    }

    public func graphExtract(text: String, domain: String) -> Result<[String: Any], Error> {
        let blob: [String: Any] = ["text": text, "domain": domain]
        let json = (try? JSONSerialization.data(withJSONObject: blob, options: [.prettyPrinted]))
            .flatMap { String(data: $0, encoding: .utf8) } ?? text
        switch runMLX(json, maxTokens: 700, fewShotTask: .graph_extract) {
        case .failure(let e): return .failure(e)
        case .success(let raw): return parseJSONObject(raw, taskTag: "graph_extract")
        }
    }
}

#endif // os(iOS) && canImport(MLXLLM)
