import Foundation
import NIOCore
import NIOHTTP1
import NaturalLanguage
#if canImport(CoreData)
import CoreData
#endif
#if canImport(Vision)
import Vision
#endif
#if canImport(CoreGraphics)
import CoreGraphics
#endif
#if canImport(ImageIO)
import ImageIO
#endif
#if canImport(FoundationModels)
import FoundationModels
#endif

// Handlers HTTP do AegisHTTPServer. Roteia para:
//   GET  /v1/health           → status + disponibilidade NL/Vision/FoundationModels
//   GET  /v1/tools            → lista de tools/endpoints/modelos
//   POST /v1/embed            → NLContextualEmbedding (iOS 17+ / macOS 14+) ou NLEmbedding.sentence fallback
//   POST /v1/ocr              → Vision VNRecognizeTextRequest (iOS 13+)
//   POST /v1/summarize        → FoundationModels LanguageModelSession (iOS 26+) — 503 caso indisponível
//   POST /v1/enrich           → AegisClaudeAgent ou FoundationModels com prompt de enriquecimento
//   POST /v1/agent            → AegisClaudeAgent.run() em modo livre (on-device)
//   POST /v1/prompt           → FoundationModels free-form text generation
//   POST /v1/vision/classify  → Vision VNClassifyImageRequest
//   POST /v1/vision/landmarks → Vision VNDetectFaceLandmarksRequest
//   POST /v1/cmd              → comandos Aegis nativos (iOS)
//
// Paridade com ZeusDaemonMac (ZeusMacHTTPHandler.swift).
// Referência: docs/superpowers/specs/2026-05-14-aegis-device-intelligence-design.md
// §Subsistemas futuros — Subsistema B (AegisFoundation).

final class AegisHTTPHandler: ChannelInboundHandler {
    typealias InboundIn = HTTPServerRequestPart
    typealias OutboundOut = HTTPServerResponsePart

    private var requestHead: HTTPRequestHead?
    private var bodyBuffer: ByteBuffer?
    private let vaultURL: URL?

    init(vaultURL: URL?) {
        self.vaultURL = vaultURL
    }

    func channelRead(context: ChannelHandlerContext, data: NIOAny) {
        switch self.unwrapInboundIn(data) {
        case .head(let head):
            self.requestHead = head
            self.bodyBuffer = context.channel.allocator.buffer(capacity: 0)
        case .body(var chunk):
            if self.bodyBuffer == nil {
                self.bodyBuffer = context.channel.allocator.buffer(capacity: chunk.readableBytes)
            }
            self.bodyBuffer?.writeBuffer(&chunk)
        case .end:
            self.handleRequest(context: context)
        }
    }

    private func handleRequest(context: ChannelHandlerContext) {
        guard let head = self.requestHead else {
            self.writeJSON(context: context, status: .badRequest, dict: ["error": "missing request head"])
            return
        }

        let bodyString: String
        if var buf = self.bodyBuffer, buf.readableBytes > 0 {
            bodyString = buf.readString(length: buf.readableBytes) ?? ""
        } else {
            bodyString = ""
        }

        // Reset state cedo para liberar memória.
        self.requestHead = nil
        self.bodyBuffer = nil

        let path = head.uri.split(separator: "?").first.map(String.init) ?? head.uri
        let method = head.method

        // CORS preflight básico (mesmo dispositivo é loopback, mas permite reuse no Mac mini).
        if method == .OPTIONS {
            var headers = HTTPHeaders()
            headers.add(name: "Access-Control-Allow-Origin", value: "*")
            headers.add(name: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS")
            headers.add(name: "Access-Control-Allow-Headers", value: "Content-Type")
            self.writeRaw(context: context, status: .noContent, headers: headers, body: nil)
            return
        }

        // Roteamento — executa em thread separada (FoundationModels / Anthropic API podem bloquear).
        let capturedContext = context
        let capturedSelf = self
        Thread.detachNewThread {
            let result = capturedSelf.route(method: method, path: path, body: bodyString)
            capturedContext.eventLoop.execute {
                guard capturedContext.channel.isActive else { return }
                capturedSelf.writeJSON(context: capturedContext, status: result.status, dict: result.payload)
            }
        }
    }

    // MARK: - Routing

    private struct Response {
        let status: HTTPResponseStatus
        let payload: [String: Any]
    }

    private func route(method: HTTPMethod, path: String, body: String) -> Response {
        switch (method, path) {
        case (.GET, "/v1/health"):
            return Response(status: .ok, payload: self.handleHealth())
        case (.GET, "/v1/tools"):
            return Response(status: .ok, payload: self.handleTools())
        case (.GET, "/v1/mcp"):
            return Response(status: .ok, payload: self.handleMCPSchema())
        case (.POST, "/v1/embed"):
            return self.handleEmbed(bodyJSON: body)
        case (.POST, "/v1/ocr"):
            return self.handleOCR(bodyJSON: body)
        case (.POST, "/v1/summarize"):
            return self.handleSummarize(bodyJSON: body)
        case (.POST, "/v1/enrich"):
            return self.handleEnrich(bodyJSON: body)
        case (.POST, "/v1/agent"):
            return self.handleAgent(bodyJSON: body)
        case (.POST, "/v1/prompt"):
            return self.handlePrompt(bodyJSON: body)
        case (.POST, "/v1/vision/classify"):
            return self.handleVisionClassify(bodyJSON: body)
        case (.POST, "/v1/vision/landmarks"):
            return self.handleVisionLandmarks(bodyJSON: body)
        case (.POST, "/v1/cmd"):
            return self.handleCmd(bodyJSON: body)
        case (.GET, "/v1/cmd"):
            // Suporte a GET com query param ?cmd=...
            return self.handleCmd(bodyJSON: body)
        default:
            return Response(status: .notFound, payload: [
                "error": "not_found",
                "method": "\(method)",
                "path": path,
                "available": [
                    "GET /v1/health", "GET /v1/tools",
                    "POST /v1/embed", "POST /v1/ocr",
                    "POST /v1/summarize", "POST /v1/enrich",
                    "POST /v1/agent", "POST /v1/prompt",
                    "POST /v1/cmd",
                    "POST /v1/vision/classify", "POST /v1/vision/landmarks"
                ]
            ])
        }
    }

    // MARK: - /v1/health

    private func handleHealth() -> [String: Any] {
        var nlAvailable = false
        var modelName = "nl-sentence-embedding-pt"
        if #available(iOS 17.0, macOS 14.0, *) {
            if NLContextualEmbedding(language: .portuguese) != nil
                || NLContextualEmbedding(language: .english) != nil {
                nlAvailable = true
                modelName = "apple-nlcontextual-pt-BR"
            }
        }

        var visionAvailable = false
        #if canImport(Vision)
        visionAvailable = true
        #endif

        var fmAvailable = false
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *) {
            fmAvailable = SystemLanguageModel.default.availability == .available
        }
        #endif

        #if os(iOS)
        let platform = "iOS"
        #elseif os(macOS)
        let platform = "macOS"
        #else
        let platform = "unknown"
        #endif

        return [
            "status": "ok",
            "fm_available": fmAvailable,
            "nl_available": nlAvailable,
            "vision_available": visionAvailable,
            "model": modelName,
            "version": "0.2.0",
            "platform": platform,
            "endpoints": [
                "GET /v1/health", "GET /v1/tools",
                "POST /v1/embed", "POST /v1/ocr",
                "POST /v1/summarize", "POST /v1/enrich",
                "POST /v1/agent", "POST /v1/prompt",
                "POST /v1/cmd",
                "POST /v1/vision/classify", "POST /v1/vision/landmarks"
            ]
        ]
    }

    // MARK: - /v1/tools

    private func handleTools() -> [String: Any] {
        return [
            "tools": [
                ["name": "embed", "endpoint": "POST /v1/embed", "input": "text",
                 "output": "vectors", "model": "NLContextualEmbedding"],
                ["name": "ocr", "endpoint": "POST /v1/ocr", "input": "image_path | image_base64",
                 "output": "text", "model": "Vision VNRecognizeTextRequest"],
                ["name": "summarize", "endpoint": "POST /v1/summarize", "input": "text",
                 "output": "summary", "model": "FoundationModels LanguageModelSession"],
                ["name": "enrich", "endpoint": "POST /v1/enrich", "input": "note_content + note_path",
                 "output": "suggested_links + tags + connections", "model": "FoundationModels"],
                ["name": "agent", "endpoint": "POST /v1/agent", "input": "question + pattern",
                 "output": "answer", "model": "AegisClaudeAgent (FoundationModels)"],
                ["name": "prompt", "endpoint": "POST /v1/prompt", "input": "instruction",
                 "output": "generated text", "model": "FoundationModels LanguageModelSession"],
                ["name": "cmd", "endpoint": "POST /v1/cmd", "input": "cmd",
                 "output": "output", "model": "iOS native (ping/status/audit/network/storage/sysinfo/spotlight/health/contacts/calendar/reminders/photos/ls)"],
                ["name": "vision_classify", "endpoint": "POST /v1/vision/classify", "input": "path + top_n",
                 "output": "classifications [{label, confidence}]", "model": "Vision VNClassifyImageRequest"],
                ["name": "vision_landmarks", "endpoint": "POST /v1/vision/landmarks", "input": "path",
                 "output": "faces with landmarks + count", "model": "Vision VNDetectFaceLandmarksRequest"]
            ]
        ]
    }

    // MARK: - /v1/mcp — schema MCP para capivara-mcp auto-discovery

    private func handleMCPSchema() -> [String: Any] {
        let profile = CapivaraDeviceProfile.current

        var fmAvailable = false
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *) {
            fmAvailable = SystemLanguageModel.default.availability == .available
        }
        #endif

        func makeTool(_ name: String, _ desc: String, _ input: [String: Any]) -> [String: Any] {
            return ["name": name, "description": desc, "inputSchema": input]
        }

        var tools: [[String: Any]] = [
            makeTool("capivara_health", "Verifica se o dispositivo está online",
                     ["type": "object", "properties": [:], "required": []]),
            makeTool("capivara_sysinfo", "Snapshot completo do sistema (\(profile.displayLabel))",
                     ["type": "object", "properties": [:], "required": []]),
            makeTool("capivara_cmd", "Executa comando nativo no dispositivo",
                     ["type": "object",
                      "properties": ["cmd": ["type": "string", "description": "comando ou linguagem natural"]],
                      "required": ["cmd"]]),
            makeTool("capivara_embed", "Embedding vetorial on-device (NLContextualEmbedding)",
                     ["type": "object",
                      "properties": ["text": ["type": "string"]],
                      "required": ["text"]]),
            makeTool("capivara_ocr", "OCR de imagem on-device (Apple Vision)",
                     ["type": "object",
                      "properties": ["image_path": ["type": "string"]],
                      "required": ["image_path"]]),
        ]

        if fmAvailable {
            tools.append(contentsOf: [
                makeTool("capivara_summarize", "Sumarização on-device (Apple FoundationModels)",
                         ["type": "object",
                          "properties": ["text": ["type": "string"], "max_tokens": ["type": "number"]],
                          "required": ["text"]]),
                makeTool("capivara_prompt", "Prompt livre on-device (Apple FoundationModels)",
                         ["type": "object",
                          "properties": ["prompt": ["type": "string"]],
                          "required": ["prompt"]]),
                makeTool("capivara_enrich", "Enriquecimento de nota on-device",
                         ["type": "object",
                          "properties": ["note_content": ["type": "string"], "note_path": ["type": "string"]],
                          "required": ["note_content"]]),
            ])
        }

        return [
            "schema_version": "1.0",
            "device": profile.displayLabel,
            "hw_model": profile.hardwareModel,
            "platform": "iOS",
            "foundation_models": fmAvailable,
            "tools": tools,
        ]
    }

    // MARK: - /v1/embed

    private func handleEmbed(bodyJSON: String) -> Response {
        guard let json = Self.parseJSON(bodyJSON),
              let text = json["text"] as? String, !text.isEmpty else {
            return Response(status: .badRequest, payload: ["error": "body inválido: requer {\"text\": \"...\"}"])
        }

        // 1) Tenta NLContextualEmbedding (preferido, iOS 17+/macOS 14+).
        if #available(iOS 17.0, macOS 14.0, *) {
            let langs: [NLLanguage] = [.portuguese, .english]
            for lang in langs {
                guard let emb = NLContextualEmbedding(language: lang) else { continue }
                if !emb.hasAvailableAssets {
                    // Tentar carregar; se falhar, segue para próxima língua.
                    _ = try? emb.load()
                }
                do {
                    let result = try emb.embeddingResult(for: text, language: lang)
                    var vector: [Float] = []
                    var tokenCount: Int = 0
                    result.enumerateTokenVectors(in: text.startIndex..<text.endIndex) { vec, _ in
                        if !vec.isEmpty {
                            // Mean-pool token vectors → vetor único por documento.
                            if vector.isEmpty {
                                vector = vec.map { Float($0) }
                            } else {
                                for (i, x) in vec.enumerated() where i < vector.count {
                                    vector[i] += Float(x)
                                }
                            }
                            tokenCount += 1
                        }
                        return true
                    }
                    let count = max(1, tokenCount)
                    let pooled = vector.map { $0 / Float(count) }
                    if !pooled.isEmpty {
                        return Response(status: .ok, payload: [
                            "vectors": [pooled],
                            "dim": pooled.count,
                            "model": "apple-nlcontextual-\(lang == .portuguese ? "pt-BR" : "en")",
                            "count": 1
                        ])
                    }
                } catch {
                    // Continua para fallback.
                    continue
                }
            }
        }

        // 2) Fallback: NLEmbedding.sentenceEmbedding em pt-BR ou en.
        if let emb = NLEmbedding.sentenceEmbedding(for: .portuguese) ?? NLEmbedding.sentenceEmbedding(for: .english),
           let vec = emb.vector(for: text) {
            let floatVec = vec.map { Float($0) }
            return Response(status: .ok, payload: [
                "vectors": [floatVec],
                "dim": floatVec.count,
                "model": "nl-sentence-embedding",
                "count": 1
            ])
        }

        return Response(status: .internalServerError, payload: [
            "error": "nenhum embedding disponível neste device (assets não baixados)"
        ])
    }

    // MARK: - /v1/enrich

    private func handleEnrich(bodyJSON: String) -> Response {
        guard let json = Self.parseJSON(bodyJSON),
              let noteContent = json["note_content"] as? String, !noteContent.isEmpty else {
            return Response(status: .badRequest, payload: [
                "error": "body inválido: requer {\"note_content\": \"...\", \"note_path\": \"...\", \"vault_summary\": \"(opcional)\"}"
            ])
        }
        let notePath = (json["note_path"] as? String) ?? "(desconhecido)"
        let vaultSummary = (json["vault_summary"] as? String) ?? ""

        // Truncar inputs para caber na janela de 4096 tokens (~12k chars conservadores).
        let maxChars = 8000
        let truncatedNote = String(noteContent.prefix(maxChars))
        let truncatedVault = String(vaultSummary.prefix(2000))

        let prompt = """
        Analise a nota abaixo e produza enriquecimento estruturado em JSON.

        Caminho da nota: \(notePath)

        Resumo do vault (contexto):
        \(truncatedVault)

        Conteúdo da nota:
        \(truncatedNote)

        Retorne APENAS um objeto JSON com a estrutura exata:
        {
          "suggested_links": [{"title": "...", "path": "...", "reason": "..."}],
          "suggested_tags": ["tag1", "tag2"],
          "connections": [{"title": "...", "path": "...", "reason": "..."}]
        }
        Não inclua texto antes ou depois do JSON. Sem markdown fences. Apenas JSON puro.
        """

        guard let agent = self.buildAgent() else {
            return Response(status: .serviceUnavailable, payload: [
                "error": "AegisClaudeAgent indisponível (FoundationModels não suportado nesta plataforma)",
                "suggested_links": [],
                "suggested_tags": [],
                "connections": []
            ])
        }
        let raw = agent.run(prompt: prompt)

        // Tentar extrair JSON do output.
        if let parsed = Self.extractJSON(from: raw) {
            return Response(status: .ok, payload: parsed)
        }
        // Fallback: devolver raw como reason para debug, com arrays vazios.
        return Response(status: .ok, payload: [
            "suggested_links": [],
            "suggested_tags": [],
            "connections": [],
            "raw": raw
        ])
    }

    // MARK: - /v1/agent

    private func handleAgent(bodyJSON: String) -> Response {
        guard let json = Self.parseJSON(bodyJSON),
              let question = json["question"] as? String, !question.isEmpty else {
            return Response(status: .badRequest, payload: [
                "error": "body inválido: requer {\"question\": \"...\", \"pattern\": \"auto|react|plan-execute|reflexion\"}"
            ])
        }
        let pattern = (json["pattern"] as? String) ?? "auto"

        guard let agent = self.buildAgent() else {
            return Response(status: .serviceUnavailable, payload: [
                "error": "AegisClaudeAgent indisponível (FoundationModels não suportado nesta plataforma)"
            ])
        }
        // Pattern hint anexado para o agent tentar seguir o estilo.
        let finalPrompt: String
        switch pattern {
        case "react":
            finalPrompt = "[ReAct] Pense em voz alta, use ferramentas iterativamente.\n\n\(question)"
        case "plan-execute":
            finalPrompt = "[Plan-Execute] Primeiro plano completo, depois execute passos.\n\n\(question)"
        case "reflexion":
            finalPrompt = "[Reflexion] Após responder, reflita sobre erros e revise.\n\n\(question)"
        default:
            finalPrompt = question
        }

        let answer = agent.run(prompt: finalPrompt)
        return Response(status: .ok, payload: [
            "answer": answer,
            "iterations": 1,
            "pattern": pattern
        ])
    }

    // MARK: - /v1/ocr (Vision)

    private func handleOCR(bodyJSON: String) -> Response {
        #if !canImport(Vision)
        return Response(status: .serviceUnavailable, payload: ["error": "Vision framework indisponível neste build"])
        #else
        guard let json = Self.parseJSON(bodyJSON) else {
            return Response(status: .badRequest, payload: [
                "error": "body inválido: requer {\"image_path\": \"...\"} ou {\"image_base64\": \"...\"}"
            ])
        }

        let imageData: Data?
        if let path = json["image_path"] as? String, !path.isEmpty {
            let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
            imageData = try? Data(contentsOf: url)
            if imageData == nil {
                return Response(status: .badRequest, payload: ["error": "não foi possível ler imagem em \(path)"])
            }
        } else if let b64 = json["image_base64"] as? String, !b64.isEmpty {
            let stripped: String
            if let comma = b64.firstIndex(of: ","), b64.hasPrefix("data:") {
                stripped = String(b64[b64.index(after: comma)...])
            } else {
                stripped = b64
            }
            imageData = Data(base64Encoded: stripped, options: .ignoreUnknownCharacters)
            if imageData == nil {
                return Response(status: .badRequest, payload: ["error": "image_base64 inválido"])
            }
        } else {
            return Response(status: .badRequest, payload: [
                "error": "requer image_path OU image_base64"
            ])
        }

        guard let data = imageData,
              let src = CGImageSourceCreateWithData(data as CFData, nil),
              let cgImage = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
            return Response(status: .badRequest, payload: ["error": "não foi possível decodificar a imagem"])
        }

        let recognitionLevel = (json["recognition_level"] as? String) ?? "accurate"
        let languages = (json["languages"] as? [String]) ?? ["pt-BR", "en-US"]

        let request = VNRecognizeTextRequest()
        request.recognitionLevel = (recognitionLevel == "fast") ? .fast : .accurate
        request.usesLanguageCorrection = true
        if #available(iOS 16.0, macOS 13.0, *) {
            request.automaticallyDetectsLanguage = false
            request.recognitionLanguages = languages
        }

        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return Response(status: .internalServerError, payload: ["error": "Vision falhou: \(error)"])
        }

        let observations = (request.results ?? [])
        var lines: [String] = []
        var confidences: [Float] = []
        for obs in observations {
            guard let top = obs.topCandidates(1).first else { continue }
            lines.append(top.string)
            confidences.append(top.confidence)
        }
        let avgConfidence = confidences.isEmpty ? 0 : confidences.reduce(0, +) / Float(confidences.count)
        return Response(status: .ok, payload: [
            "text": lines.joined(separator: "\n"),
            "lines": lines,
            "line_count": lines.count,
            "avg_confidence": avgConfidence,
            "model": "Vision VNRecognizeTextRequest",
            "languages": languages
        ])
        #endif
    }

    // MARK: - /v1/summarize (FoundationModels)

    private func handleSummarize(bodyJSON: String) -> Response {
        guard let json = Self.parseJSON(bodyJSON),
              let text = json["text"] as? String, !text.isEmpty else {
            return Response(status: .badRequest, payload: ["error": "body inválido: requer {\"text\": \"...\"}"])
        }
        let maxTokens = (json["max_tokens"] as? Int) ?? 500
        let instructions = (json["instructions"] as? String)
            ?? "Resuma o texto a seguir de forma concisa e fiel ao original. Mantenha o idioma do texto."

        return self.runFoundationModel(
            instructions: instructions,
            prompt: text,
            maxTokens: maxTokens,
            extraPayload: ["task": "summarize"]
        )
    }

    // MARK: - /v1/prompt (FoundationModels, free-form generation)

    private func handlePrompt(bodyJSON: String) -> Response {
        guard let json = Self.parseJSON(bodyJSON),
              let instruction = json["instruction"] as? String, !instruction.isEmpty else {
            return Response(status: .badRequest, payload: [
                "error": "body inválido: requer {\"instruction\": \"...\"}"
            ])
        }
        let maxTokens = (json["max_tokens"] as? Int) ?? 300
        let deterministic = (json["deterministic"] as? Bool) ?? true
        let _ = (json["prewarm"] as? Bool) ?? false // accepted but no-op

        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *) {
            let model = SystemLanguageModel.default
            switch model.availability {
            case .available:
                let session = LanguageModelSession()
                let options: GenerationOptions
                if deterministic {
                    options = GenerationOptions(temperature: 0.0, maximumResponseTokens: maxTokens)
                } else {
                    options = GenerationOptions(maximumResponseTokens: maxTokens)
                }
                let sem = DispatchSemaphore(value: 0)
                var resultText: String = ""
                var resultError: Error? = nil
                Task {
                    do {
                        let resp = try await session.respond(to: instruction, options: options)
                        resultText = resp.content
                    } catch {
                        resultError = error
                    }
                    sem.signal()
                }
                _ = sem.wait(timeout: .now() + .seconds(120))
                if let err = resultError {
                    return Response(status: .internalServerError, payload: [
                        "error": "FoundationModels falhou: \(err)"
                    ])
                }
                return Response(status: .ok, payload: [
                    "output": resultText,
                    "model": "apple-foundationmodels-systemlanguagemodel",
                    "deterministic": deterministic,
                    "max_tokens": maxTokens
                ])
            case .unavailable(let reason):
                return Response(status: .serviceUnavailable, payload: [
                    "error": "FoundationModels indisponível: \(reason)"
                ])
            @unknown default:
                return Response(status: .serviceUnavailable, payload: [
                    "error": "FoundationModels com estado desconhecido"
                ])
            }
        } else {
            return Response(status: .serviceUnavailable, payload: [
                "error": "FoundationModels requer iOS 26.0+ (este device é mais antigo)"
            ])
        }
        #else
        return Response(status: .serviceUnavailable, payload: [
            "error": "FoundationModels framework não disponível neste build"
        ])
        #endif
    }

    // MARK: - /v1/vision/classify (Vision VNClassifyImageRequest)

    private func handleVisionClassify(bodyJSON: String) -> Response {
        #if !canImport(Vision)
        return Response(status: .serviceUnavailable, payload: ["error": "Vision framework indisponível neste build"])
        #else
        guard let json = Self.parseJSON(bodyJSON),
              let path = json["path"] as? String, !path.isEmpty else {
            return Response(status: .badRequest, payload: [
                "error": "body inválido: requer {\"path\": \"...\"}"
            ])
        }
        let topN = (json["top_n"] as? Int) ?? 8

        let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        guard let data = try? Data(contentsOf: url),
              let src = CGImageSourceCreateWithData(data as CFData, nil),
              let cgImage = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
            return Response(status: .badRequest, payload: [
                "error": "não foi possível ler/decodificar imagem em \(path)"
            ])
        }

        let request = VNClassifyImageRequest()
        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return Response(status: .internalServerError, payload: ["error": "Vision falhou: \(error)"])
        }

        let observations = request.results ?? []
        let sorted = observations.sorted { $0.confidence > $1.confidence }
        let limited = Array(sorted.prefix(topN))
        let classifications: [[String: Any]] = limited.map { obs in
            return [
                "label": obs.identifier,
                "confidence": Float(obs.confidence)
            ]
        }
        return Response(status: .ok, payload: [
            "classifications": classifications,
            "topN": topN,
            "path": path,
            "count": classifications.count,
            "model": "Vision VNClassifyImageRequest"
        ])
        #endif
    }

    // MARK: - /v1/vision/landmarks (Vision VNDetectFaceLandmarksRequest)

    private func handleVisionLandmarks(bodyJSON: String) -> Response {
        #if !canImport(Vision)
        return Response(status: .serviceUnavailable, payload: ["error": "Vision framework indisponível neste build"])
        #else
        guard let json = Self.parseJSON(bodyJSON),
              let path = json["path"] as? String, !path.isEmpty else {
            return Response(status: .badRequest, payload: [
                "error": "body inválido: requer {\"path\": \"...\"}"
            ])
        }

        let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        guard let data = try? Data(contentsOf: url),
              let src = CGImageSourceCreateWithData(data as CFData, nil),
              let cgImage = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
            return Response(status: .badRequest, payload: [
                "error": "não foi possível ler/decodificar imagem em \(path)"
            ])
        }

        let request = VNDetectFaceLandmarksRequest()
        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return Response(status: .internalServerError, payload: ["error": "Vision falhou: \(error)"])
        }

        let observations = request.results ?? []
        var faces: [[String: Any]] = []
        for obs in observations {
            var faceDict: [String: Any] = [
                "boundingBox": [
                    "x": Double(obs.boundingBox.origin.x),
                    "y": Double(obs.boundingBox.origin.y),
                    "width": Double(obs.boundingBox.size.width),
                    "height": Double(obs.boundingBox.size.height)
                ],
                "confidence": Float(obs.confidence)
            ]
            if let landmarks = obs.landmarks {
                var landmarkNames: [String] = []
                if landmarks.faceContour != nil { landmarkNames.append("faceContour") }
                if landmarks.leftEye != nil { landmarkNames.append("leftEye") }
                if landmarks.rightEye != nil { landmarkNames.append("rightEye") }
                if landmarks.leftEyebrow != nil { landmarkNames.append("leftEyebrow") }
                if landmarks.rightEyebrow != nil { landmarkNames.append("rightEyebrow") }
                if landmarks.nose != nil { landmarkNames.append("nose") }
                if landmarks.noseCrest != nil { landmarkNames.append("noseCrest") }
                if landmarks.medianLine != nil { landmarkNames.append("medianLine") }
                if landmarks.outerLips != nil { landmarkNames.append("outerLips") }
                if landmarks.innerLips != nil { landmarkNames.append("innerLips") }
                if landmarks.leftPupil != nil { landmarkNames.append("leftPupil") }
                if landmarks.rightPupil != nil { landmarkNames.append("rightPupil") }
                faceDict["landmarks"] = landmarkNames
            } else {
                faceDict["landmarks"] = [] as [String]
            }
            faces.append(faceDict)
        }
        return Response(status: .ok, payload: [
            "faces": faces,
            "count": faces.count,
            "path": path,
            "model": "Vision VNDetectFaceLandmarksRequest"
        ])
        #endif
    }

    // MARK: - FoundationModels runner (gated)

    private func runFoundationModel(
        instructions: String,
        prompt: String,
        maxTokens: Int,
        extraPayload: [String: Any]
    ) -> Response {
        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *) {
            let model = SystemLanguageModel.default
            switch model.availability {
            case .available:
                let session = LanguageModelSession(instructions: instructions)
                let options = GenerationOptions(maximumResponseTokens: maxTokens)
                let sem = DispatchSemaphore(value: 0)
                var resultText: String = ""
                var resultError: Error? = nil
                Task {
                    do {
                        let resp = try await session.respond(to: prompt, options: options)
                        resultText = resp.content
                    } catch {
                        resultError = error
                    }
                    sem.signal()
                }
                _ = sem.wait(timeout: .now() + .seconds(120))
                if let err = resultError {
                    return Response(status: .internalServerError, payload: [
                        "error": "FoundationModels falhou: \(err)"
                    ])
                }
                var payload: [String: Any] = [
                    "text": resultText,
                    "model": "apple-foundationmodels-systemlanguagemodel"
                ]
                for (k, v) in extraPayload { payload[k] = v }
                return Response(status: .ok, payload: payload)
            case .unavailable(let reason):
                return Response(status: .serviceUnavailable, payload: [
                    "error": "FoundationModels indisponível: \(reason)"
                ])
            @unknown default:
                return Response(status: .serviceUnavailable, payload: [
                    "error": "FoundationModels com estado desconhecido"
                ])
            }
        } else {
            return Response(status: .serviceUnavailable, payload: [
                "error": "FoundationModels requer iOS 26.0+ (este device é mais antigo)"
            ])
        }
        #else
        return Response(status: .serviceUnavailable, payload: [
            "error": "FoundationModels framework não disponível neste build (compilar em iOS 26+ SDK)"
        ])
        #endif
    }

    // MARK: - Agent factory

    /// Reusa AegisClaudeAgent (FoundationModels on-device). Sessão dedicada "http-agent".
    private func buildAgent() -> AegisClaudeAgent? {
        let sm = AegisSessionManager.shared
        let session: NSManagedObject = sm.activeSession() ?? sm.createOrActivate(name: "http-agent")
        let executor: (String) -> String = { _ in
            // O HTTP path não expõe o AegisCommandExecutor diretamente — comandos do agent
            // ficam restritos às tools nativas. Para aegis_cmd retornamos placeholder.
            return "comandos aegis_cmd via HTTP não suportados — use o canal SSH"
        }
        return AegisClaudeAgent(session: session, autoYes: false, executor: executor)
    }

    // MARK: - Helpers

    private static func parseJSON(_ s: String) -> [String: Any]? {
        guard let data = s.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private static func extractJSON(from raw: String) -> [String: Any]? {
        // Tentativa 1: parse direto.
        if let direct = parseJSON(raw) { return direct }
        // Tentativa 2: localizar primeiro `{` e último `}`.
        guard let start = raw.firstIndex(of: "{"),
              let end = raw.lastIndex(of: "}"), start < end else { return nil }
        let candidate = String(raw[start...end])
        return parseJSON(candidate)
    }

    private func writeJSON(context: ChannelHandlerContext, status: HTTPResponseStatus, dict: [String: Any]) {
        var headers = HTTPHeaders()
        headers.add(name: "Content-Type", value: "application/json; charset=utf-8")
        headers.add(name: "Access-Control-Allow-Origin", value: "*")
        let body: ByteBuffer?
        if let data = try? JSONSerialization.data(withJSONObject: dict, options: [.fragmentsAllowed]) {
            var buf = context.channel.allocator.buffer(capacity: data.count)
            buf.writeBytes(data)
            body = buf
            headers.add(name: "Content-Length", value: "\(data.count)")
        } else {
            body = nil
            headers.add(name: "Content-Length", value: "0")
        }
        self.writeRaw(context: context, status: status, headers: headers, body: body)
    }

    private func writeRaw(context: ChannelHandlerContext, status: HTTPResponseStatus,
                          headers: HTTPHeaders, body: ByteBuffer?) {
        let head = HTTPResponseHead(version: .init(major: 1, minor: 1), status: status, headers: headers)
        context.write(self.wrapOutboundOut(.head(head)), promise: nil)
        if let body = body {
            context.write(self.wrapOutboundOut(.body(.byteBuffer(body))), promise: nil)
        }
        context.writeAndFlush(self.wrapOutboundOut(.end(nil))).whenComplete { _ in
            context.close(promise: nil)
        }
    }

    // MARK: - /v1/cmd — executa comando Zeus nativo (cross-device via Tailscale)

    private func handleCmd(bodyJSON: String) -> Response {
        let cmd: String
        if let json = Self.parseJSON(bodyJSON), let c = json["cmd"] as? String, !c.isEmpty {
            cmd = c
        } else if !bodyJSON.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    && !bodyJSON.hasPrefix("{") {
            cmd = bodyJSON.trimmingCharacters(in: .whitespacesAndNewlines)
        } else {
            return Response(status: .badRequest, payload: ["error": "body inválido: requer {\"cmd\": \"...\"}"])
        }

        // Reutiliza a mesma lógica do executor SSH — executa síncronamente (já em thread separada).
        let executor = AegisCommandExecutorBridge()
        let output = executor.run(cmd)
        return Response(status: .ok, payload: ["output": output, "cmd": cmd])
    }

    func errorCaught(context: ChannelHandlerContext, error: Error) {
        print("[AegisHTTPHandler] error: \(error)")
        context.close(promise: nil)
    }
}

// MARK: - Bridge síncrona para /v1/cmd (evita dependência circular com AegisCommandExecutor)

private final class AegisCommandExecutorBridge {
    private static let docsPath = FileManager.default
        .urls(for: .documentDirectory, in: .userDomainMask).first?.path ?? NSTemporaryDirectory()

    func run(_ cmd: String) -> String {
        let args = cmd.split(separator: " ").map(String.init)
        guard let binary = args.first else { return "Comando vazio." }
        switch binary {
        case "ping":    return "pong from iOS Native Daemon!"
        case "status":  return "Zeus HTTP Bridge OK"
        case "audit":   return AegisNativeTools.deviceAudit()
        case "network": return AegisNativeTools.networkStatus()
        case "storage":
            let attrs = (try? FileManager.default.attributesOfFileSystem(forPath: NSHomeDirectory())) ?? [:]
            let total = (attrs[.systemSize] as? Int64 ?? 0)
            let free  = (attrs[.systemFreeSize] as? Int64 ?? 0)
            let used  = total - free
            func fmt(_ b: Int64) -> String {
                let gb = Double(b) / 1_073_741_824
                return gb >= 1 ? String(format: "%.1f GB", gb) : String(format: "%.0f MB", Double(b) / 1_048_576)
            }
            let pct = total > 0 ? Int((Double(used) / Double(total)) * 100) : 0
            return "Armazenamento: \(fmt(used)) usados / \(fmt(free)) livres / \(fmt(total)) total (\(pct)%)"
        case "sysinfo":
            let pi = ProcessInfo.processInfo
            let attrs = (try? FileManager.default.attributesOfFileSystem(forPath: NSHomeDirectory())) ?? [:]
            let free  = (attrs[.systemFreeSize] as? Int64 ?? 0)
            let total = (attrs[.systemSize] as? Int64 ?? 0)
            return "iOS \(pi.operatingSystemVersionString) | \(pi.processorCount) cores | \(free/1_073_741_824)GB livre / \(total/1_073_741_824)GB total | host: \(pi.hostName)"
        case "spotlight":
            let q = args.dropFirst().joined(separator: " ")
            return q.isEmpty ? "Uso: spotlight <query>" : AegisNativeTools.spotlightSearch(query: q)
        case "health":
            return AegisNativeTools.healthRead(metric: args.dropFirst().first ?? "steps")
        case "contacts":
            return AegisNativeTools.contactsSearch(query: args.dropFirst().joined(separator: " "))
        case "calendar":
            return AegisNativeTools.calendarQuery(query: args.dropFirst().joined(separator: " "))
        case "reminders":
            return AegisNativeTools.remindersQuery(query: args.dropFirst().joined(separator: " "))
        case "photos":
            return AegisNativeTools.photosInfo(query: args.dropFirst().joined(separator: " "))
        case "ls":
            let path = args.count > 1 ? args[1] : Self.docsPath
            let url  = URL(fileURLWithPath: path)
            let items = (try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: [.isDirectoryKey], options: .skipsHiddenFiles)) ?? []
            return items.isEmpty ? "(vazio)" : items.map { $0.lastPathComponent }.sorted().joined(separator: "\n")
        case "secaudit":
            return "\(AegisNativeTools.deviceAudit())\n\n\(AegisNativeTools.networkStatus())"

        case "claude":
            // Roteia para AegisClaudeAgent via HTTP — executa prompt on-device
            let prompt = args.dropFirst().joined(separator: " ")
            guard !prompt.isEmpty else {
                return "Uso: claude <prompt>\nExemplo: claude 'qual a diferença entre habeas corpus e mandado de segurança?'"
            }
            // Executa síncronamente (já estamos em thread separada no NIO handler)
            let sem = DispatchSemaphore(value: 0)
            var result = "(sem resposta)"
            Task {
                result = await AegisLocalBridge.shared.execute("claude \(prompt)")
                sem.signal()
            }
            sem.wait()
            return result

        case "profile":
            let p = CapivaraDeviceProfile.current
            return "\(p.displayLabel)\n\(p.contextLine)\n\(p.capabilitiesSummary)"

        default:
            return """
            Comando '\(binary)' não reconhecido.
            Disponíveis via HTTP:
              sistema:  ping, status, sysinfo, storage, network, audit, secaudit, profile
              apps iOS: spotlight, health, contacts, calendar, reminders, photos, ls
              IA:       claude <prompt>
            Via SSH (porta 2222): acesso completo ao AegisLocalBridge + todos os comandos
            """
        }
    }
}
