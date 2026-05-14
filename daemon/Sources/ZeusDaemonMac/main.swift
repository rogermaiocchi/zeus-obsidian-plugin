// main.swift — ZeusDaemonMac
//
// Daemon macOS standalone que expõe inteligência on-device via HTTP loopback:
//   POST /v1/embed     → NLContextualEmbedding (NaturalLanguage)
//   POST /v1/ocr       → Vision VNRecognizeTextRequest
//   POST /v1/summarize → FoundationModels LanguageModelSession (macOS 26+)
//   POST /v1/enrich    → FoundationModels com contexto de vault
//   GET  /v1/health    → status + plataforma + disponibilidade FM
//   GET  /v1/tools     → lista de capacidades
//
// Contraparte Mac do AegisDaemon iOS (porta 2223), pensado para rodar como
// LaunchAgent (~/Library/LaunchAgents/com.maiocchi.zeusdaemon.plist) no Mac mini.
// Tríade Operacional: este é o tier 6 (on-device) da cascata Zeus quando o
// conteúdo é confidencial/sigiloso e não pode sair do disco local.

import Foundation
import NIOCore
import NIOPosix
import NIOHTTP1
#if canImport(Darwin)
import Darwin
#endif

// MARK: - Argument parsing

struct ZeusArgs {
    // Default 0.0.0.0 para aceitar conexões Tailscale (cross-device)
    var host: String = "0.0.0.0"
    var port: Int = 2223
    var vaultPath: String? = nil

    static func parse(_ argv: [String]) -> ZeusArgs {
        var args = ZeusArgs()
        var i = 1
        while i < argv.count {
            let a = argv[i]
            switch a {
            case "--port":
                if i + 1 < argv.count, let p = Int(argv[i + 1]) { args.port = p; i += 1 }
            case "--host":
                if i + 1 < argv.count { args.host = argv[i + 1]; i += 1 }
            case "--vault":
                if i + 1 < argv.count { args.vaultPath = argv[i + 1]; i += 1 }
            case "--help", "-h":
                print("""
                ZeusDaemonMac — Zeus on-device intelligence daemon (macOS)

                Usage:
                  ZeusDaemonMac [--port 2223] [--host 127.0.0.1] [--vault PATH]

                Endpoints:
                  GET  /v1/health
                  GET  /v1/tools
                  POST /v1/embed      {"text": "..."}
                  POST /v1/ocr        {"image_path": "..."} or {"image_base64": "..."}
                  POST /v1/summarize  {"text": "...", "max_tokens": 500}
                  POST /v1/enrich     {"note_content": "...", "note_path": "..."}
                """)
                exit(0)
            default:
                FileHandle.standardError.write("[ZeusDaemonMac] aviso: argumento ignorado: \(a)\n".data(using: .utf8) ?? Data())
            }
            i += 1
        }
        return args
    }
}

let args = ZeusArgs.parse(CommandLine.arguments)
let vaultURL: URL? = args.vaultPath.map { URL(fileURLWithPath: $0) }

// MARK: - Server bootstrap

let group = MultiThreadedEventLoopGroup(numberOfThreads: 1)

let bootstrap = ServerBootstrap(group: group)
    .serverChannelOption(ChannelOptions.socketOption(.so_reuseaddr), value: 1)
    .childChannelInitializer { channel in
        channel.pipeline.configureHTTPServerPipeline(withErrorHandling: true).flatMap {
            channel.pipeline.addHandler(ZeusMacHTTPHandler(vaultURL: vaultURL))
        }
    }
    .childChannelOption(ChannelOptions.socketOption(.so_reuseaddr), value: 1)
    .childChannelOption(ChannelOptions.maxMessagesPerRead, value: 1)

let serverChannel: Channel
do {
    serverChannel = try bootstrap.bind(host: args.host, port: args.port).wait()
} catch {
    FileHandle.standardError.write("[ZeusDaemonMac] FATAL: bind \(args.host):\(args.port) falhou: \(error)\n".data(using: .utf8) ?? Data())
    exit(2)
}

let macKind = ZeusMacHTTPHandler.macKindLabel()
let macHW   = ZeusMacHTTPHandler.macHWModel()
print("[ZeusDaemonMac] Dispositivo: \(macKind) (\(macHW))")
print("[ZeusDaemonMac] HTTP escutando em http://\(args.host):\(args.port)")
print("[ZeusDaemonMac] endpoints: GET /v1/health · GET /v1/tools · POST /v1/embed · POST /v1/ocr · POST /v1/summarize · POST /v1/enrich · POST /v1/cmd")
fflush(stdout)

// MARK: - Signal handling for graceful shutdown

let shutdownLock = NSLock()
var didShutdown = false

func gracefulShutdown(reason: String) {
    shutdownLock.lock()
    defer { shutdownLock.unlock() }
    if didShutdown { return }
    didShutdown = true
    print("[ZeusDaemonMac] shutdown: \(reason)")
    do {
        try serverChannel.close().wait()
    } catch {
        FileHandle.standardError.write("[ZeusDaemonMac] erro fechando channel: \(error)\n".data(using: .utf8) ?? Data())
    }
    try? group.syncShutdownGracefully()
    exit(0)
}

let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigtermSource.setEventHandler { gracefulShutdown(reason: "SIGTERM") }
sigtermSource.resume()
signal(SIGTERM, SIG_IGN)

let sigintSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
sigintSource.setEventHandler { gracefulShutdown(reason: "SIGINT") }
sigintSource.resume()
signal(SIGINT, SIG_IGN)

// Keep alive: NIO already runs accept loop on its event loop group; main thread
// just needs to park. Use RunLoop.main.run() so DispatchSources on .main fire.
RunLoop.main.run()
