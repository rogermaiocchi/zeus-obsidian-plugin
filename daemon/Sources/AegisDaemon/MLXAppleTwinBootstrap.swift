import Foundation

#if os(iOS)
#if canImport(FoundationModels)
import FoundationModels
#endif

/// Bootstrap do MLX Apple-Twin no daemon iOS. Chamar uma vez no startup
/// do AegisDaemon, idealmente em `AegisDaemon.start()` (antes do listen()).
///
/// Política:
///   • Se FoundationModels estiver `.available` → não wire-a o twin (Apple
///     Intelligence cobre). Twin fica nil → cadeia de fallback em
///     AegisHTTPHandlers usa direto o FM.
///   • Se FM indisponível → escolhe E2B (iPhone) ou E4B (iPad) baseado em
///     `UIDevice.current.userInterfaceIdiom` e RAM disponível.
///   • Pesos são On-Demand Resource (ODR) com tag "gemma-twin". Se ainda
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

        // 2) Escolhe variante baseada no device idiom + RAM
        //
        // Fase 2 parity (v1.0.0-fase2-parity): em iPad é OBRIGATÓRIO usar E4B
        // mesmo em modelos com 6GB. As tarefas pesadas (graph_extract + agent Q&A
        // com contexto recuperado) saturam E2B; E4B suporta com folga.
        // iPhone fica em E2B (8GB+) ou E2B-Q3 (6GB legado).
        let idiom = currentIdiom()
        let totalRAM = ProcessInfo.processInfo.physicalMemory // bytes
        let ramGB = Double(totalRAM) / 1_073_741_824.0

        // Fase A v1.0.0: usa pesos STOCK do Gemma 4 + few-shot prompting.
        // O nome de resource segue o esquema gemma-twin-vX.Y onde X.Y é a versão
        // do PACK (não do app). v1.0 = stock; v1.1+ = adapters fundidos pela Fase B.
        // O bootstrap tenta sempre a versão mais recente disponível em cache ODR.
        let twinVersion = currentTwinVersion()  // ex.: "v1.0" (stock) ou "v1.2" (Fase B)
        let resourceName: String
        if idiom == "pad" {
            // iPad SEMPRE recebe E4B — paridade total Mac↔iOS exige capacidade.
            resourceName = "gemma-4-e4b-it-q4-mlx-\(twinVersion)"
        } else if ramGB >= 7.5 {
            resourceName = "gemma-4-e2b-it-q4-mlx-\(twinVersion)"      // iPhone 15 Pro+/16/17 (8GB+)
        } else {
            resourceName = "gemma-4-e2b-it-q3-mlx-low-\(twinVersion)"  // iPhone 6GB legado
        }
        NSLog("[AppleTwin] device=\(idiom) ramGB=\(ramGB) twinVersion=\(twinVersion) → variante=\(resourceName)")

        // 3) Pede On-Demand Resource (cancela se já em cache)
        //    Tag inclui versão para que Fase B publique novos packs sem rebuild.
        let odrTag = "gemma-twin-\(twinVersion)"
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
                let runner = MLXGemmaTwinRunner(
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

    private static func currentIdiom() -> String {
        #if canImport(UIKit)
        // Indireto via runtime para não exigir import UIKit no daemon target.
        if let cls = NSClassFromString("UIDevice"),
           let inst = (cls as? NSObject.Type)?.value(forKey: "currentDevice") as? NSObject {
            let raw = inst.value(forKey: "userInterfaceIdiom") as? Int ?? -1
            // 0 = phone, 1 = pad, 2 = tv, 5 = mac
            switch raw {
            case 0: return "phone"
            case 1: return "pad"
            default: return "other"
            }
        }
        #endif
        return "phone"
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
