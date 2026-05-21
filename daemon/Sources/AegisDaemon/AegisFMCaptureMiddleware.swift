import Foundation

// AegisFMCaptureMiddleware — Fase B v1.0.0.
//
// No Mac mini, depois de o handler FoundationModels devolver uma resposta válida
// para /v1/summarize, /v1/refine, /v1/enrich, /v1/prompt, /v1/hyde, /v1/agent ou
// /v1/graph/extract, este middleware CLONA o par (prompt, response) para um
// buffer JSONL append-only em ~/Datasets/apple-twin/continuous.jsonl.
//
// O buffer é o input do AegisTwinTrainer (~/Library/LaunchAgents/com.maiocchi.aegis.twin-trainer.plist),
// que dispara mini-LoRA quando o threshold é atingido.
//
// Política:
//   • Apenas macOS (compilado #if os(macOS)).
//   • Apenas quando o provider efetivamente usado foi 'apple-intelligence' (resposta
//     vinda do FoundationModels nativo — dataset de ORÁCULO real do Roger em produção).
//   • Append-only, sem locks pesados (FileHandle com writeAt fim de arquivo).
//   • Nunca bloqueia a resposta HTTP: faz fire-and-forget em queue de baixa prioridade.

public enum AegisFMCaptureMiddleware {

    #if os(macOS)
    private static let queue = DispatchQueue(label: "org.maiocchi.aegis.fm-capture",
                                             qos: .utility, attributes: [])
    private static let bufferURL: URL = {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let dir = home.appendingPathComponent("Datasets/apple-twin", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent("continuous.jsonl")
    }()
    private static let enabledFlagURL: URL = {
        let home = FileManager.default.homeDirectoryForCurrentUser
        return home.appendingPathComponent("Library/Application Support/Aegis/fm-capture.enabled")
    }()
    #endif

    /// Chamado pelos handlers HTTP imediatamente antes de devolver `Response.ok`
    /// quando a resposta veio do FoundationModels nativo.
    public static func capture(task: String,
                               input: [String: Any],
                               output: Any,
                               provider: String,
                               model: String) {
        #if os(macOS)
        guard provider == "apple-intelligence" else { return }
        guard FileManager.default.fileExists(atPath: enabledFlagURL.path) else {
            return  // captura só roda se o flag-file existir (opt-in explícito)
        }
        let record: [String: Any] = [
            "id": UUID().uuidString,
            "task": task,
            "input": input,
            "output": output,
            "provider": provider,
            "model_source": model,
            "captured_at": ISO8601DateFormatter().string(from: Date()),
            "origin": "fm-capture-middleware"
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: record,
                                                      options: [.fragmentsAllowed, .sortedKeys]) else { return }
        let targetURL = bufferURL
        queue.async {
            do {
                if !FileManager.default.fileExists(atPath: targetURL.path) {
                    FileManager.default.createFile(atPath: targetURL.path, contents: nil)
                }
                let fh = try FileHandle(forWritingTo: targetURL)
                defer { try? fh.close() }
                try fh.seekToEnd()
                fh.write(data)
                fh.write(Data([0x0A]))  // newline
            } catch {
                NSLog("[FMCapture] erro de escrita: \(error)")
            }
        }
        #endif
    }
}
