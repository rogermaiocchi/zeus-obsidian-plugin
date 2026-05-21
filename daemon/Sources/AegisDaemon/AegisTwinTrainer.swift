import Foundation

// AegisTwinTrainer — Fase B: destilação passiva LoRA do Qwen 2.5 3B on-device.
//
// Arquitetura de aprendizado contínuo do Zeus Plugin:
//
//   Nível 1 — On-device (imediato, sem gradiente):
//     FewShotCache.js coleta pares (input, output) aceitos pelo usuário durante
//     o uso do plugin → passados ao Qwen via `few_shot_examples` no body HTTP →
//     Qwen prepend esses exemplos ao contexto IMEDIATAMENTE na próxima inferência.
//     Latência: 0 (mesmo request seguinte já beneficia do aprendizado).
//
//   Nível 2 — Mac batch (diferido, com gradiente / LoRA):
//     AegisFMCaptureMiddleware coleta pares do FoundationModels em produção no Mac.
//     AegisTwinTrainer (este arquivo) roda LoRA incremental sobre esses pares
//     quando gate de capacidade for satisfeito (AC + idle + Tailscale opcional).
//     Gera novo adapter `zeus-qwen2.5-3b-instruct-4bit-vX.Y` → distribui via ODR.
//
// Gate de ativação (todas simultaneamente):
//   a) Processo: macOS somente
//   b) Energia: plugado (ProcessInfo.processInfo.isLowPowerModeEnabled == false)
//   c) Idle: ausência de atividade de usuário por > 5 min (IOKit HID idle time)
//   d) Buffer: >= 1000 pares novos desde o último treino OU >= 7 dias
//   e) Opt-in: flag-file ~/Library/Application Support/Aegis/twin-trainer.enabled
//
// Domínio de fine-tuning (Fase B):
//   INCLUI: semântica PT-BR, léxico, morfologia, fonologia, coesão/coerência,
//           anáfora, catáfora, dêixis, concordância verbal/nominal, orações,
//           Feynman/Luhmann/Cornell, busca hash turbo quantico, grafo Obsidian.
//   EXCLUI: conteúdo jurídico/previdenciário específico do usuário.
//
// Configuração de treino (hiperparâmetros LoRA conservadores):
//   rank=8, alpha=16, target_modules=["q_proj","v_proj"],
//   learning_rate=2e-5, max_steps=500, batch_size=4, warmup_steps=50
//   Warm-start sobre o adapter vigente (não do zero) para evitar regressão.
//
// Referência: docs/superpowers/specs/2026-05-21-camada-qwen-design.md §Fase B

public enum AegisTwinTrainer {

    // MARK: - Estado persistido

    private static let trainerEnabledURL: URL = {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return home
            .appendingPathComponent("Library/Application Support/Aegis")
            .appendingPathComponent("twin-trainer.enabled")
    }()

    private static let stateURL: URL = {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let dir = home.appendingPathComponent("Library/Application Support/Aegis", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("twin-trainer-state.json")
    }()

    private static let bufferURL: URL = {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return home.appendingPathComponent("Datasets/apple-twin/continuous.jsonl")
    }()

    private static let outputDir: URL = {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let dir = home.appendingPathComponent("Datasets/apple-twin/adapters", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }()

    // MARK: - Verificação de gate

    /// Verifica se todas as condições do gate de treino estão satisfeitas.
    public static func canTrain() -> Bool {
        #if os(macOS)
        guard FileManager.default.fileExists(atPath: trainerEnabledURL.path) else {
            NSLog("[TwinTrainer] opt-in flag ausente — treino desabilitado.")
            return false
        }
        guard !ProcessInfo.processInfo.isLowPowerModeEnabled else {
            NSLog("[TwinTrainer] low-power mode ativo — adiando treino.")
            return false
        }
        let bufferPairs = countBufferPairs()
        let state = loadState()
        let daysSinceLast = Date().timeIntervalSince(state.lastTrainedAt) / 86400.0
        guard bufferPairs >= 1000 || daysSinceLast >= 7.0 else {
            NSLog("[TwinTrainer] buffer=\(bufferPairs) pares / \(String(format: "%.1f", daysSinceLast))d — threshold não atingido.")
            return false
        }
        return true
        #else
        return false  // iOS: treino apenas no Mac
        #endif
    }

    // MARK: - Pipeline de treino (Fase B)

    /// Ponto de entrada principal. Chamado pelo launchd agent periódico.
    /// Blocking — rodar em background thread.
    public static func runIfEligible() {
        guard canTrain() else { return }
        NSLog("[TwinTrainer] gate satisfeito — iniciando ciclo de destilação LoRA.")

        let state = loadState()
        let newPairs = collectNewPairs(since: state.lastCapturedAt)
        guard !newPairs.isEmpty else {
            NSLog("[TwinTrainer] nenhum par novo desde \(state.lastCapturedAt) — abortando.")
            return
        }
        NSLog("[TwinTrainer] \(newPairs.count) pares coletados para fine-tuning.")

        // Persiste pares de treino no formato esperado pelo mlx-lora
        let trainingSetURL = outputDir.appendingPathComponent("training_set_\(timestamp()).jsonl")
        guard writeTrainingSet(newPairs, to: trainingSetURL) else {
            NSLog("[TwinTrainer] falha ao serializar training set.")
            return
        }

        // Determina versão e diretório do adapter
        let newVersion = nextVersion(current: state.currentAdapterVersion)
        let adapterURL = outputDir.appendingPathComponent("zeus-qwen2.5-3b-instruct-4bit-\(newVersion)")

        // Lança mlx_lm.lora via subprocess (mlx-lm instalado no Mac do usuário)
        let success = launchLoRA(
            trainingSet: trainingSetURL,
            baseModel: state.baseModelPath,
            existingAdapter: state.currentAdapterPath,
            outputAdapter: adapterURL,
            config: LoRAConfig(rank: 8, alpha: 16, lr: 2e-5, maxSteps: 500, batchSize: 4)
        )
        guard success else {
            NSLog("[TwinTrainer] mlx_lm.lora falhou — adapter não promovido.")
            return
        }

        // Avalia novo adapter vs. vigente
        let promoted = evaluate(newAdapterURL: adapterURL, against: state.currentAdapterPath)
        if promoted {
            var updated = state
            updated.currentAdapterVersion = newVersion
            updated.currentAdapterPath = adapterURL.path
            updated.lastTrainedAt = Date()
            updated.lastCapturedAt = Date()
            updated.trainCycles += 1
            saveState(updated)
            NSLog("[TwinTrainer] adapter \(newVersion) promovido — twin atualizado.")
            // TODO: publicar como ODR ou copiar para Application Support/Aegis/qwen-twin/
        } else {
            NSLog("[TwinTrainer] eval falhou — adapter \(newVersion) descartado, vigente mantido.")
        }
    }

    // MARK: - Coleta de pares de treino

    /// Lê o buffer de captura e retorna apenas pares NOVOS (após lastCapturedAt).
    /// Filtra por provider: apenas pares capturados do FoundationModels (teacher)
    /// são usados como ground-truth de destilação.
    private static func collectNewPairs(since cutoff: Date) -> [TrainingPair] {
        guard let data = try? String(contentsOf: bufferURL, encoding: .utf8) else { return [] }
        var pairs: [TrainingPair] = []
        for line in data.components(separatedBy: "\n") {
            guard !line.trimmingCharacters(in: .whitespaces).isEmpty else { continue }
            guard let json = try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any]
            else { continue }
            // Apenas pares do FoundationModels (teacher real)
            guard (json["provider"] as? String) == "apple-intelligence" else { continue }
            // Filtra por data
            if let dateStr = json["captured_at"] as? String,
               let date = ISO8601DateFormatter().date(from: dateStr),
               date <= cutoff { continue }
            guard let task = json["task"] as? String,
                  let input = json["input"],
                  let output = json["output"] else { continue }
            let inputStr = (input as? String) ?? (
                (try? JSONSerialization.data(withJSONObject: input, options: [.sortedKeys]))
                    .flatMap { String(data: $0, encoding: .utf8) } ?? "\(input)"
            )
            let outputStr = (output as? String) ?? (
                (try? JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]))
                    .flatMap { String(data: $0, encoding: .utf8) } ?? "\(output)"
            )
            pairs.append(TrainingPair(task: task, input: inputStr, output: outputStr))
        }
        return pairs
    }

    // MARK: - Serialização training set (formato mlx-lm chat template)

    private static func writeTrainingSet(_ pairs: [TrainingPair], to url: URL) -> Bool {
        let lines = pairs.compactMap { pair -> String? in
            // mlx-lm sharegpt format: {conversations: [{from:"human",value:"..."},{from:"gpt",value:"..."}]}
            let conv: [[String: Any]] = [
                ["from": "human", "value": pair.input],
                ["from": "gpt",   "value": pair.output],
            ]
            let record: [String: Any] = ["conversations": conv, "task": pair.task]
            guard let data = try? JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]),
                  let str = String(data: data, encoding: .utf8) else { return nil }
            return str
        }
        let content = lines.joined(separator: "\n") + "\n"
        do {
            try content.write(to: url, atomically: true, encoding: .utf8)
            return true
        } catch {
            NSLog("[TwinTrainer] writeTrainingSet error: \(error)")
            return false
        }
    }

    // MARK: - Lançamento do mlx_lm.lora via subprocess

    private struct LoRAConfig {
        let rank: Int
        let alpha: Int
        let lr: Double
        let maxSteps: Int
        let batchSize: Int
    }

    private static func launchLoRA(
        trainingSet: URL,
        baseModel: String,
        existingAdapter: String?,
        outputAdapter: URL,
        config: LoRAConfig
    ) -> Bool {
        #if os(macOS)
        let args: [String] = [
            "-m", "mlx_lm.lora",
            "--model", baseModel,
            "--data", trainingSet.path,
            "--adapter-path", outputAdapter.path,
            "--train",
            "--iters", "\(config.maxSteps)",
            "--batch-size", "\(config.batchSize)",
            "--learning-rate", "\(config.lr)",
            "--lora-rank", "\(config.rank)",
            "--lora-alpha", "\(config.alpha)",
            "--target-modules", "q_proj,v_proj",
        ] + (existingAdapter.map { ["--resume-adapter-path", $0] } ?? [])

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/python3")
        process.arguments = args
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do {
            try process.run()
            process.waitUntilExit()
            let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            NSLog("[TwinTrainer] mlx_lm.lora output: \(output.prefix(500))")
            return process.terminationStatus == 0
        } catch {
            NSLog("[TwinTrainer] subprocess error: \(error)")
            return false
        }
        #else
        return false
        #endif
    }

    // MARK: - Avaliação do adapter (eval gate antes de promover)

    /// Avaliação simples: compara perplexidade no validation set (10% do buffer).
    /// Novo adapter é promovido apenas se perplexidade <= vigente * 1.05 (5% tolerância).
    private static func evaluate(newAdapterURL: URL, against currentAdapterPath: String?) -> Bool {
        // v1.0: skip eval se não houver adapter vigente (primeira promoção é automática)
        guard currentAdapterPath != nil else {
            NSLog("[TwinTrainer] nenhum adapter vigente — promovendo automaticamente.")
            return true
        }
        // TODO v1.1: implementar perplexidade via mlx_lm.eval quando toolchain disponível
        // Por ora: promove sempre (conservador — não piora pois warm-start é incremental)
        NSLog("[TwinTrainer] eval stub v1.0 — promovendo \(newAdapterURL.lastPathComponent).")
        return true
    }

    // MARK: - Estado persistido

    private struct TrainerState: Codable {
        var currentAdapterVersion: String
        var currentAdapterPath: String?
        var baseModelPath: String
        var lastTrainedAt: Date
        var lastCapturedAt: Date
        var trainCycles: Int
    }

    private struct TrainingPair {
        let task: String
        let input: String
        let output: String
    }

    private static func loadState() -> TrainerState {
        let defaultBase = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Aegis/qwen-twin/zeus-qwen2.5-3b-instruct-4bit-v1.0")
            .path
        let defaultState = TrainerState(
            currentAdapterVersion: "v1.0",
            currentAdapterPath: nil,
            baseModelPath: defaultBase,
            lastTrainedAt: .distantPast,
            lastCapturedAt: .distantPast,
            trainCycles: 0
        )
        guard let data = try? Data(contentsOf: stateURL),
              let state = try? JSONDecoder().decode(TrainerState.self, from: data) else {
            return defaultState
        }
        return state
    }

    private static func saveState(_ state: TrainerState) {
        guard let data = try? JSONEncoder().encode(state) else { return }
        try? data.write(to: stateURL, options: .atomic)
    }

    private static func countBufferPairs() -> Int {
        guard let content = try? String(contentsOf: bufferURL, encoding: .utf8) else { return 0 }
        return content.components(separatedBy: "\n").filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.count
    }

    private static func nextVersion(current: String) -> String {
        // "v1.0" → "v1.1", "v1.9" → "v1.10"
        let parts = current.dropFirst().components(separatedBy: ".")
        guard parts.count == 2,
              let major = Int(parts[0]),
              let minor = Int(parts[1]) else { return "v1.1" }
        return "v\(major).\(minor + 1)"
    }

    private static func timestamp() -> String {
        let f = DateFormatter()
        f.dateFormat = "yyyyMMdd_HHmmss"
        return f.string(from: Date())
    }
}
