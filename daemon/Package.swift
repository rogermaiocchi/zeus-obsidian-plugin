// swift-tools-version: 5.9
// Package.swift — Projeto Aegis (Servidor SSH Nativo iOS + Daemon HTTP Mac)
//
// Este pacote constrói a infraestrutura de rede do Aegis. Dois produtos:
//   1. `AegisDaemon` (library) — embutida no MetassistemaApp iOS (porta SSH 2222
//      + HTTP loopback 2223 para o plugin Obsidian).
//   2. `ZeusDaemonMac` (executable) — daemon macOS standalone que expõe
//      NLContextualEmbedding + Vision OCR + FoundationModels via HTTP em
//      127.0.0.1:2223, contraparte do daemon iOS para o Mac mini.

import PackageDescription

let package = Package(
    name: "ProjetoAegis",
    platforms: [
        .iOS(.v16),
        .macOS(.v14)
    ],
    products: [
        .library(
            name: "AegisDaemon",
            targets: ["AegisDaemon"]
        ),
        .executable(
            name: "ZeusDaemonMac",
            targets: ["ZeusDaemonMac"]
        )
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-nio.git", from: "2.65.0"),
        .package(url: "https://github.com/apple/swift-nio-ssh.git", from: "0.8.0"),
        .package(url: "https://github.com/apple/swift-nio-transport-services.git", from: "1.20.1")
    ],
    targets: [
        .target(
            name: "AegisDaemon",
            dependencies: [
                .product(name: "NIOCore", package: "swift-nio"),
                .product(name: "NIOPosix", package: "swift-nio"),
                .product(name: "NIOHTTP1", package: "swift-nio"),
                .product(name: "NIOSSH", package: "swift-nio-ssh"),
                .product(name: "NIOTransportServices", package: "swift-nio-transport-services")
            ],
            resources: [
                .process("Resources")
            ]
        ),
        .executableTarget(
            name: "ZeusDaemonMac",
            dependencies: [
                .product(name: "NIOCore", package: "swift-nio"),
                .product(name: "NIOPosix", package: "swift-nio"),
                .product(name: "NIOHTTP1", package: "swift-nio")
            ],
            path: "Sources/ZeusDaemonMac"
        )
    ]
)
