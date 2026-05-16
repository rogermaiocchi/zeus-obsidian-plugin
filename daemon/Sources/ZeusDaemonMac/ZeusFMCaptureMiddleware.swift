import Foundation

// ZeusFMCaptureMiddleware — Fase B v1.0.0.
//
// No Mac mini, depois de o handler FoundationModels devolver uma resposta válida
// para /v1/summarize, /v1/refine, /v1/enrich, /v1/prompt, /v1/hyde, /v1/agent ou
// /v1/graph/extract, este middleware CLONA o par (prompt, response) para um
// buffer JSONL append-only em ~/Datasets/apple-twin/continuous.jsonl.
//
// O buffer é o input do twin_trainer.py (~/Library/LaunchAgents/com.maiocchi.aegis.twin-trainer.plist),
// que dispara mini-LoRA quando o threshold é atingido.
//
// Política:
//   • Apenas quando o flag-file ~/Library/Application Support/Aegis/fm-capture.enabled existir.
//   • Apenas quando a resposta veio do FoundationModels nativo (provider apple-intelligence).
//   • Append-only, fire-and-forget em queue utility (não bloqueia HTTP).

public enum ZeusFMCaptureMiddleware {

    private static let queue = DispatchQueue(label: "org.maiocchi.zeus.fm-capture",
                                             qos: .utility)
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

    /// Chamado pelos handlers HTTP imediatamente antes de devolver Response.ok
    /// quando a resposta veio do FoundationModels nativo.
    public static func capture(task: String,
                               input: [String: Any],
                               output: Any,
                               model: String) {
        guard FileManager.default.fileExists(atPath: enabledFlagURL.path) else { return }
        queue.async {
            let record: [String: Any] = [
                "id": UUID().uuidString,
                "task": task,
                "input": input,
                "output": output,
                "provider": "apple-intelligence",
                "model_source": model,
                "captured_at": ISO8601DateFormatter().string(from: Date()),
                "origin": "zeus-fm-capture-middleware"
            ]
            guard let data = try? JSONSerialization.data(withJSONObject: record,
                                                          options: [.fragmentsAllowed, .sortedKeys]) else { return }
            do {
                if !FileManager.default.fileExists(atPath: bufferURL.path) {
                    FileManager.default.createFile(atPath: bufferURL.path, contents: nil)
                }
                let fh = try FileHandle(forWritingTo: bufferURL)
                defer { try? fh.close() }
                try fh.seekToEnd()
                fh.write(data)
                fh.write(Data([0x0A]))
            } catch {
                NSLog("[ZeusFMCapture] erro de escrita: \(error)")
            }
        }
    }
}
