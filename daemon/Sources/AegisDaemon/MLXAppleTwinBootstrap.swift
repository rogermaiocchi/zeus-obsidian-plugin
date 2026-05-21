import Foundation

#if os(iOS)
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Bootstrap do MLX Apple-Twin no daemon iOS. Chamar uma vez no startup
/// do AegisDaemon, idealmente em `AegisDaemon.start()` (antes do listen()).
///
/// v1.15.0 — Motor migrado de Gemma 4 E2B/E4B para Qwen 2.5 3B-Instruct 4-bit.
/// Um único modelo para todos os devices (iPhone + iPad), ~1.8 GB int4.
/// Vantagens: melhor PT-BR, RAM menor no iPad, JSON determinístico.
///
/// Política:
///   • Se FoundationModels estiver `.available` → não wire-a o twin (Apple
///     Intelligence cobre). Twin fica nil → cadeia de fallback em
///     AegisHTTPHandlers usa direto o FM.
///   • Se FM indisponível → carrega Qwen 2.5 3B-Instruct 4-bit (único modelo).
///   • Pesos são On-Demand Resource (ODR) com tag "qwen-twin". Se ainda
///     não baixaram, dispara o download e mantém o twin como nil até estar pronto.

public enum MLXAppleTwinBootstrap {

    public static func wireUpIfNeeded() {
        // 1) Verifica Apple Intelligence
        #if canImport(FoundationModels)
        if #available(iOS 26.0, *) {
            if case .available = SystemLanguageModel.default.availability {
                NSLog("[AppleTwin] FoundationModels disponível — twin não será carregado.")
                return
            }
        }
        #endif

        // 2) Qwen 2.5 3B-Instruct 4-bit — único modelo para todos os devices.
        // v1.15.0: elimina a divisão E2B/E4B (Gemma). O Qwen 3B cabe em
        // qualquer iPhone A14+ ou iPad com 4 GB+ de RAM livre (~1.8 GB int4).
        // RAM check: avisa se <3.5 GB livre mas ainda tenta (dispositivos iOS
        // gerenciam memória dinamicamente — o OS pagina agressivamente).
        let totalRAM = ProcessInfo.processInfo.physicalMemory
        let ramGB = Double(totalRAM) / 1_073_741_824.0
        if ramGB < 3.5 {
            NSLog("[AppleTwin] AVISO: dispositivo com \(String(format: "%.1f", ramGB)) GB RAM — Qwen 3B pode ser paginado pelo OS.")
        }

        // Nome do resource segue esquema qwen-twin-vX.Y onde X.Y é a versão
        // do pack (v1.0 = stock Qwen 2.5-3B-Instruct + few-shot Fase A;
        //          v1.1+ = adapters LoRA PT-BR da Fase B, distribuídos via ODR).
        let twinVersion = currentTwinVersion()
        let resourceName = "zeus-qwen2.5-3b-instruct-4bit-\(twinVersion)"
        NSLog("[AppleTwin] ramGB=\(String(format: "%.1f", ramGB)) twinVersion=\(twinVersion) → variante=\(resourceName)")

        // 3) Pede On-Demand Resource (cancela se já em cache)
        let odrTag = "qwen-twin-\(twinVersion)"
        requestODR(tag: odrTag) { result in
            switch result {
            case .failure(let err):
                NSLog("[AppleTwin] ODR fetch falhou: \(err)")
            case .success(let bundleRoot):
                let modelURL = bundleRoot.appendingPathComponent(resourceName, isDirectory: true)
                guard FileManager.default.fileExists(atPath: modelURL.path) else {
                    NSLog("[AppleTwin] ODR baixado mas pasta '\(resourceName)' não encontrada em \(bundleRoot.path)")
                    return
                }
                #if canImport(MLXLLM)
                let runner = MLXQwenRunner(
                    modelURL: modelURL,
                    systemPrompt: AppleTwinSystemPrompt.canonical
                )
                MLXAppleTwinProvider.shared = runner
                NSLog("[AppleTwin] runtime MLX wired com \(resourceName) — pronto para inferência on-device.")
                #endif
            }
        }
    }

    // MARK: - Helpers

    /// Lê a versão do twin ativa de `Application Support/Aegis/twin-version.txt`.
    /// Default: "v1.0" (Fase A — pesos stock + few-shot).
    /// A Fase B (twin-trainer) atualiza esse arquivo após promover um adapter.
    private static func currentTwinVersion() -> String {
        let fm = FileManager.default
        if let appSupport = fm.urls(for: .applicationSupportDirectory, in: .userDomainMask).first {
            let path = appSupport
                .appendingPathComponent("Aegis", isDirectory: true)
                .appendingPathComponent("twin-version.txt")
            if let s = try? String(contentsOf: path, encoding: .utf8) {
                let v = s.trimmingCharacters(in: .whitespacesAndNewlines)
                if v.hasPrefix("v") { return v }
            }
        }
        return "v1.0"
    }

    private static func requestODR(tag: String, completion: @escaping (Result<URL, Error>) -> Void) {
        let request = NSBundleResourceRequest(tags: [tag])
        request.loadingPriority = NSBundleResourceRequestLoadingPriorityUrgent
        request.beginAccessingResources { error in
            if let error { completion(.failure(error)); return }
            completion(.success(request.bundle.bundleURL))
            // Mantém request vivo enquanto provider está wired — não chamamos endAccessingResources().
        }
    }
}

#else
// macOS build: bootstrap é no-op (FoundationModels nativo é suficiente)
public enum MLXAppleTwinBootstrap {
    public static func wireUpIfNeeded() { /* macOS: no-op */ }
}
#endif
