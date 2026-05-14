import Foundation
import NIOCore
import NIOPosix
import NIOHTTP1

// Implementa o Subsistema B (AegisFoundation) descrito em
// docs/superpowers/specs/2026-05-14-aegis-device-intelligence-design.md §Subsistemas futuros.
// Expõe endpoints HTTP REST loopback para o plugin Obsidian iOS consumir via
// requestUrl (bypass de CORS) — embedding / enrich / agent / health.

public final class AegisHTTPServer {
    private let group: EventLoopGroup
    private var channel: Channel?
    private let vaultURL: URL?
    private let ownsGroup: Bool

    public init(group: EventLoopGroup? = nil, vaultURL: URL? = nil) {
        if let g = group {
            self.group = g
            self.ownsGroup = false
        } else {
            self.group = MultiThreadedEventLoopGroup(numberOfThreads: 1)
            self.ownsGroup = true
        }
        self.vaultURL = vaultURL
    }

    /// Inicia o listener HTTP em loopback (default 127.0.0.1:2223).
    public func start(host: String = "127.0.0.1", port: Int = 2223) async throws {
        let vault = self.vaultURL
        let bootstrap = ServerBootstrap(group: group)
            .serverChannelOption(ChannelOptions.socketOption(.so_reuseaddr), value: 1)
            .childChannelInitializer { channel in
                channel.pipeline.configureHTTPServerPipeline(withErrorHandling: true).flatMap {
                    channel.pipeline.addHandler(AegisHTTPHandler(vaultURL: vault))
                }
            }
            .childChannelOption(ChannelOptions.socketOption(.so_reuseaddr), value: 1)
            .childChannelOption(ChannelOptions.maxMessagesPerRead, value: 1)

        let bound = try await bootstrap.bind(host: host, port: port).get()
        self.channel = bound
        print("[AegisHTTPServer] 🛰️ HTTP escutando em http://\(host):\(port) — endpoints /v1/embed /v1/enrich /v1/agent /v1/health")
    }

    public func stop() async throws {
        try await channel?.close().get()
        if ownsGroup {
            try await group.shutdownGracefully()
        }
        print("[AegisHTTPServer] 🛰️ Desligado.")
    }
}
