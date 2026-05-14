// ZeusMacHTTPHandler.swift — Mac-flavored HTTP handler para ZeusDaemonMac.
//
// Reimplementação portável (sem UIKit, sem AegisClaudeAgent, sem CoreData) do
// AegisHTTPHandlers.swift do daemon iOS. Endpoints:
//   GET  /v1/health
//   GET  /v1/tools
//   POST /v1/embed     — NLContextualEmbedding (NaturalLanguage)
//   POST /v1/ocr       — Vision VNRecognizeTextRequest
//   POST /v1/summarize — FoundationModels LanguageModelSession (macOS 26+)
//   POST /v1/enrich    — FoundationModels com leitura de arquivo de vault
//
// FoundationModels é gated atrás de `#if canImport(FoundationModels)` +
// `if #available(macOS 26.0, *)`. Quando ausente, /v1/summarize e /v1/enrich
// retornam 503 com mensagem clara.

import Foundation
import NIOCore
import NIOHTTP1
import NaturalLanguage
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
#if canImport(Translation)
import Translation
#endif

final class ZeusMacHTTPHandler: ChannelInboundHandler {
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

        self.requestHead = nil
        self.bodyBuffer = nil

        let path = head.uri.split(separator: "?").first.map(String.init) ?? head.uri
        let method = head.method

        if method == .OPTIONS {
            var headers = HTTPHeaders()
            headers.add(name: "Access-Control-Allow-Origin", value: "*")
            headers.add(name: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS")
            headers.add(name: "Access-Control-Allow-Headers", value: "Content-Type")
            self.writeRaw(context: context, status: .noContent, headers: headers, body: nil)
            return
        }

        // Off the event loop: NL / Vision / FoundationModels podem bloquear.
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
        case (.POST, "/v1/prompt"):
            return self.handlePrompt(bodyJSON: body)
        case (.POST, "/v1/vision/classify"):
            return self.handleVisionClassify(bodyJSON: body)
        case (.POST, "/v1/vision/landmarks"):
            return self.handleVisionLandmarks(bodyJSON: body)
        case (.POST, "/v1/cmd"):
            return self.handleCmd(bodyJSON: body)
        case (.POST, "/v1/passport/extract"):
            return self.handlePassportExtract(bodyJSON: body)
        case (.POST, "/v1/passport/batch-extract"):
            return self.handlePassportBatchExtract(bodyJSON: body)
        case (.POST, "/v1/passport/find"):
            return self.handlePassportFind(bodyJSON: body)
        case (.POST, "/v1/content/get"):
            return self.handleContentGet(bodyJSON: body)
        // v0.5 — recovered v0.7 endpoints (full Apple ecosystem coverage)
        case (.POST, "/v1/translate"):
            return self.handleTranslate(bodyJSON: body)
        case (.POST, "/v1/nl/tag"):
            return self.handleNLTag(bodyJSON: body)
        case (.POST, "/v1/nl/sentiment"):
            return self.handleNLSentiment(bodyJSON: body)
        case (.POST, "/v1/nl/language-detect"):
            return self.handleNLLanguageDetect(bodyJSON: body)
        case (.POST, "/v1/vision/saliency"):
            return self.handleVisionSaliency(bodyJSON: body)
        case (.POST, "/v1/vision/feature-print"):
            return self.handleVisionFeaturePrint(bodyJSON: body)
        case (.POST, "/v1/vision/aesthetics"):
            return self.handleVisionAesthetics(bodyJSON: body)
        case (.POST, "/v1/vision/barcode"):
            return self.handleVisionBarcode(bodyJSON: body)
        case (.POST, "/v1/vision/document"):
            return self.handleVisionDocument(bodyJSON: body)
        case (.POST, "/v1/spotlight/search"):
            return self.handleSpotlightSearch(bodyJSON: body)
        case (.POST, "/v1/data-detect"):
            return self.handleDataDetect(bodyJSON: body)
        default:
            return Response(status: .notFound, payload: [
                "error": "not_found",
                "method": "\(method)",
                "path": path,
                "available": [
                    "GET /v1/health", "GET /v1/tools",
                    "POST /v1/embed", "POST /v1/ocr",
                    "POST /v1/summarize", "POST /v1/enrich",
                    "POST /v1/prompt", "POST /v1/cmd",
                    "POST /v1/vision/classify", "POST /v1/vision/landmarks",
                    "POST /v1/vision/saliency", "POST /v1/vision/feature-print",
                    "POST /v1/vision/aesthetics", "POST /v1/vision/barcode",
                    "POST /v1/vision/document",
                    "POST /v1/passport/extract", "POST /v1/passport/batch-extract",
                    "POST /v1/passport/find", "POST /v1/content/get",
                    "POST /v1/translate",
                    "POST /v1/nl/tag", "POST /v1/nl/sentiment", "POST /v1/nl/language-detect",
                    "POST /v1/data-detect", "POST /v1/spotlight/search"
                ]
            ])
        }
    }

    // MARK: - /v1/health

    private func handleHealth() -> [String: Any] {
        var nlAvailable = false
        var nlModel = "nl-sentence-embedding"
        if #available(macOS 14.0, *) {
            if NLContextualEmbedding(language: .portuguese) != nil
                || NLContextualEmbedding(language: .english) != nil {
                nlAvailable = true
                nlModel = "apple-nlcontextual-pt-BR"
            }
        }

        var visionAvailable = false
        #if canImport(Vision)
        visionAvailable = true
        #endif

        var fmAvailable = false
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            fmAvailable = SystemLanguageModel.default.availability == .available
        }
        #endif

        let endpoints = [
            "GET /v1/health", "GET /v1/tools", "GET /v1/mcp",
            "POST /v1/embed", "POST /v1/ocr",
            "POST /v1/summarize", "POST /v1/enrich",
            "POST /v1/prompt", "POST /v1/cmd",
            "POST /v1/vision/classify", "POST /v1/vision/landmarks",
            "POST /v1/vision/saliency", "POST /v1/vision/feature-print",
            "POST /v1/vision/aesthetics", "POST /v1/vision/barcode",
            "POST /v1/vision/document",
            "POST /v1/passport/extract", "POST /v1/passport/batch-extract",
            "POST /v1/passport/find", "POST /v1/content/get",
            "POST /v1/translate",
            "POST /v1/nl/tag", "POST /v1/nl/sentiment", "POST /v1/nl/language-detect",
            "POST /v1/data-detect", "POST /v1/spotlight/search"
        ]
        return [
            "status": "ok",
            "platform": "macOS",
            "device": Self.macKindLabel(),
            "hw_model": Self.macHWModel(),
            "version": "0.5.0",
            "nl_available": nlAvailable,
            "nl_model": nlModel,
            "vision_available": visionAvailable,
            "fm_available": fmAvailable,
            "endpoints": endpoints,
            "endpoint_count": endpoints.count
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
                ["name": "prompt", "endpoint": "POST /v1/prompt", "input": "instruction",
                 "output": "generated text", "model": "FoundationModels LanguageModelSession"],
                ["name": "cmd", "endpoint": "POST /v1/cmd", "input": "cmd",
                 "output": "output", "model": "macOS shell (ping/sysinfo/storage/battery/network/audit/profile/ls/defaults/brew/diskutil/launchctl/osascript/pmset)"],
                ["name": "vision_classify", "endpoint": "POST /v1/vision/classify", "input": "path + top_n",
                 "output": "classifications [{label, confidence}]", "model": "Vision VNClassifyImageRequest"],
                ["name": "vision_landmarks", "endpoint": "POST /v1/vision/landmarks", "input": "path",
                 "output": "faces with landmarks + count", "model": "Vision VNDetectFaceLandmarksRequest"],
                ["name": "passport_extract", "endpoint": "POST /v1/passport/extract",
                 "input": "path + content? + domain_options",
                 "output": "passport (concepts + one_line_summary + domain + difficulty)",
                 "model": "NLTagger + FoundationModels"],
                ["name": "passport_batch_extract", "endpoint": "POST /v1/passport/batch-extract",
                 "input": "paths[] + domain_options",
                 "output": "passports[] + errors[] + elapsed_ms",
                 "model": "NLTagger + FoundationModels"],
                ["name": "passport_find", "endpoint": "POST /v1/passport/find",
                 "input": "query + embeddings_jsonl_path + passports_jsonl_path + top_n + min_score + concept_filter",
                 "output": "results[] (cards sem content) + token-saving metrics",
                 "model": "NLContextualEmbedding cosine + passport index"],
                ["name": "content_get", "endpoint": "POST /v1/content/get",
                 "input": "path + vault_root + max_chars",
                 "output": "content + char_count + frontmatter",
                 "model": "filesystem"]
            ]
        ]
    }

    // MARK: - /v1/mcp — schema MCP para auto-discovery pelo capivara-mcp

    private func handleMCPSchema() -> [String: Any] {
        let kind  = Self.macKindLabel()
        let model = Self.macHWModel()

        var fmAvailable = false
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            fmAvailable = SystemLanguageModel.default.availability == .available
        }
        #endif

        func tool(_ name: String, _ desc: String, _ input: [String: Any]) -> [String: Any] {
            return ["name": name, "description": desc, "inputSchema": input]
        }

        var tools: [[String: Any]] = [
            tool("capivara_health",  "Status completo do \(kind)",
                 ["type": "object", "properties": [:], "required": []]),
            tool("capivara_sysinfo", "Snapshot do sistema macOS (\(kind) \(model))",
                 ["type": "object", "properties": [:], "required": []]),
            tool("capivara_cmd",     "Executa comando macOS nativo (shell, brew, launchctl, osascript, pmset)",
                 ["type": "object",
                  "properties": ["cmd": ["type": "string", "description": "comando ou linguagem natural"]],
                  "required": ["cmd"]]),
            tool("capivara_embed",   "Embedding vetorial on-device (NLContextualEmbedding)",
                 ["type": "object",
                  "properties": ["text": ["type": "string"]],
                  "required": ["text"]]),
            tool("capivara_ocr",     "OCR de imagem on-device (Apple Vision)",
                 ["type": "object",
                  "properties": ["image_path": ["type": "string"]],
                  "required": ["image_path"]]),
        ]

        if fmAvailable {
            tools.append(contentsOf: [
                tool("capivara_summarize", "Sumarização on-device (Apple FoundationModels macOS 26+)",
                     ["type": "object",
                      "properties": ["text": ["type": "string"], "max_tokens": ["type": "number"]],
                      "required": ["text"]]),
                tool("capivara_prompt",    "Prompt livre on-device (Apple FoundationModels macOS 26+)",
                     ["type": "object",
                      "properties": ["prompt": ["type": "string"]],
                      "required": ["prompt"]]),
                tool("capivara_enrich",    "Enriquecimento de nota on-device via FoundationModels",
                     ["type": "object",
                      "properties": ["note_content": ["type": "string"], "note_path": ["type": "string"]],
                      "required": ["note_content"]]),
            ])
        }

        return [
            "schema_version": "1.0",
            "device": kind,
            "hw_model": model,
            "platform": "macOS",
            "foundation_models": fmAvailable,
            "tools": tools,
        ]
    }

    // MARK: - /v1/embed (NLContextualEmbedding)

    private func handleEmbed(bodyJSON: String) -> Response {
        guard let json = Self.parseJSON(bodyJSON),
              let text = json["text"] as? String, !text.isEmpty else {
            return Response(status: .badRequest, payload: ["error": "body inválido: requer {\"text\": \"...\"}"])
        }

        if #available(macOS 14.0, *) {
            let langs: [NLLanguage] = [.portuguese, .english]
            for lang in langs {
                guard let emb = NLContextualEmbedding(language: lang) else { continue }
                if !emb.hasAvailableAssets {
                    _ = try? emb.load()
                }
                do {
                    let result = try emb.embeddingResult(for: text, language: lang)
                    var vector: [Float] = []
                    var tokenCount: Int = 0
                    result.enumerateTokenVectors(in: text.startIndex..<text.endIndex) { vec, _ in
                        if !vec.isEmpty {
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
                    continue
                }
            }
        }

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
            // Aceita data: URLs ou base64 puro.
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
        if #available(macOS 13.0, *) {
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

    // MARK: - /v1/enrich (FoundationModels + vault file)

    private func handleEnrich(bodyJSON: String) -> Response {
        guard let json = Self.parseJSON(bodyJSON) else {
            return Response(status: .badRequest, payload: [
                "error": "body inválido: requer {\"note_content\": \"...\", \"note_path\": \"...\"}"
            ])
        }

        var noteContent = (json["note_content"] as? String) ?? ""
        let notePath = (json["note_path"] as? String) ?? "(desconhecido)"
        let vaultSummary = (json["vault_summary"] as? String) ?? ""

        // Se note_content vazio mas note_path fornecido, tentar ler do vault.
        if noteContent.isEmpty, !notePath.isEmpty, notePath != "(desconhecido)" {
            let resolved: URL
            if notePath.hasPrefix("/") {
                resolved = URL(fileURLWithPath: notePath)
            } else if let base = self.vaultURL {
                resolved = base.appendingPathComponent(notePath)
            } else {
                resolved = URL(fileURLWithPath: (notePath as NSString).expandingTildeInPath)
            }
            if let content = try? String(contentsOf: resolved, encoding: .utf8) {
                noteContent = content
            }
        }

        guard !noteContent.isEmpty else {
            return Response(status: .badRequest, payload: [
                "error": "note_content vazio e note_path não resolveu — forneça pelo menos um"
            ])
        }

        let truncatedNote = String(noteContent.prefix(8000))
        let truncatedVault = String(vaultSummary.prefix(2000))

        let instructions = """
        Você é um assistente de enriquecimento de notas Markdown em um vault Obsidian.
        Analise o conteúdo fornecido e retorne APENAS JSON puro (sem fences, sem comentários).
        Estrutura obrigatória:
        {
          "suggested_links": [{"title": "...", "path": "...", "reason": "..."}],
          "suggested_tags": ["tag1", "tag2"],
          "connections": [{"title": "...", "path": "...", "reason": "..."}]
        }
        """

        let prompt = """
        Caminho da nota: \(notePath)

        Resumo do vault (contexto):
        \(truncatedVault)

        Conteúdo da nota:
        \(truncatedNote)
        """

        let res = self.runFoundationModel(
            instructions: instructions,
            prompt: prompt,
            maxTokens: 800,
            extraPayload: ["task": "enrich", "note_path": notePath]
        )

        // Se a FM respondeu, tentar extrair JSON estruturado.
        if res.status == .ok, let raw = res.payload["text"] as? String {
            if let parsed = Self.extractJSON(from: raw) {
                var merged = parsed
                merged["note_path"] = notePath
                merged["model"] = res.payload["model"] ?? "FoundationModels"
                return Response(status: .ok, payload: merged)
            }
            return Response(status: .ok, payload: [
                "suggested_links": [],
                "suggested_tags": [],
                "connections": [],
                "raw": raw,
                "note_path": notePath,
                "model": res.payload["model"] ?? "FoundationModels"
            ])
        }
        return res
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
        let _ = (json["prewarm"] as? Bool) ?? false // accepted but no-op (session prewarm is internal)

        #if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
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
                "error": "FoundationModels requer macOS 26.0+ (esta máquina é mais antiga)"
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
        // Sort by confidence descending and take top N.
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

    // MARK: - /v1/cmd (macOS system commands)

    private func handleCmd(bodyJSON: String) -> Response {
        guard let json = Self.parseJSON(bodyJSON),
              let cmd = json["cmd"] as? String, !cmd.isEmpty else {
            return Response(status: .badRequest, payload: [
                "error": "requer {\"cmd\": \"...\"}",
                "examples": ["ping", "sysinfo", "storage", "battery", "network", "audit",
                             "ls", "defaults read NSGlobalDomain", "brew list",
                             "diskutil list", "launchctl list"]
            ])
        }

        let tokens = cmd.split(separator: " ").map(String.init)
        guard let binary = tokens.first else {
            return Response(status: .badRequest, payload: ["error": "comando vazio"])
        }
        let rest = Array(tokens.dropFirst())
        let output = executeMacCmd(binary: binary, args: rest)
        return Response(status: .ok, payload: ["output": output, "cmd": cmd, "platform": "macOS"])
    }

    private func executeMacCmd(binary: String, args: [String]) -> String {
        switch binary {
        case "ping":
            return "pong from ZeusDaemonMac! (\(Self.macKindLabel()))"

        case "sysinfo":
            return macSysInfo()

        case "storage":
            return macStorage()

        case "battery":
            return macBattery()

        case "network":
            return macNetwork()

        case "audit":
            return macAudit()

        case "profile":
            return macProfile()

        case "ls":
            let path = args.first ?? NSHomeDirectory()
            return shellRun(["/bin/ls", "-la", path])

        case "defaults":
            guard !args.isEmpty else { return "Uso: defaults read|write|delete [domain] [key]" }
            return shellRun(["/usr/bin/defaults"] + args, timeout: 5)

        case "brew":
            guard !args.isEmpty else { return "Uso: brew list|info|update|upgrade <pkg>" }
            return shellRun(["/opt/homebrew/bin/brew"] + args, timeout: 30)

        case "diskutil":
            guard !args.isEmpty else { return "Uso: diskutil list|info|verifyDisk <disk>" }
            return shellRun(["/usr/sbin/diskutil"] + args, timeout: 10)

        case "launchctl":
            guard !args.isEmpty else { return "Uso: launchctl list|load|unload|start|stop <label>" }
            return shellRun(["/bin/launchctl"] + args, timeout: 5)

        case "osascript":
            guard !args.isEmpty else { return "Uso: osascript -e '<script>'" }
            return shellRun(["/usr/bin/osascript"] + args, timeout: 10)

        case "pmset":
            return shellRun(["/usr/bin/pmset"] + (args.isEmpty ? ["-g", "batt"] : args), timeout: 5)

        case "system_profiler":
            let type = args.first ?? "SPSoftwareDataType"
            return shellRun(["/usr/sbin/system_profiler", type, "-json"], timeout: 15)

        case "claude":
            return runClaudeCLI(args: args)

        case "git":
            guard !args.isEmpty else { return "Uso: git status|log|diff|pull|push ..." }
            let allowed = ["status", "log", "diff", "show", "branch", "remote", "fetch", "pull"]
            guard let sub = args.first, allowed.contains(sub) else {
                return "git sub-comandos permitidos: \(allowed.joined(separator: ", "))"
            }
            return shellRun(["/usr/bin/git"] + args, timeout: 15)

        case "ssh":
            guard !args.isEmpty else { return "Uso: ssh <host> [comando]" }
            // Apenas comandos não-interativos (exige argumento de comando após o host)
            guard args.count >= 2 else { return "SSH: forneça host e comando. Ex: ssh iphone.ts.net sysinfo" }
            let host = args[0]
            let remoteCmd = Array(args.dropFirst()).joined(separator: " ")
            return shellRun(["/usr/bin/ssh", "-o", "StrictHostKeyChecking=no",
                              "-o", "ConnectTimeout=5", host, remoteCmd], timeout: 15)

        case "cat":
            guard let path = args.first else { return "Uso: cat <caminho>" }
            return shellRun(["/bin/cat", path], timeout: 5)

        case "grep":
            guard args.count >= 2 else { return "Uso: grep <padrão> <arquivo>" }
            return shellRun(["/usr/bin/grep"] + args, timeout: 5)

        case "find":
            guard !args.isEmpty else { return "Uso: find <path> [args]" }
            return shellRun(["/usr/bin/find"] + args, timeout: 10)

        case "curl":
            // Apenas GET sem flags de escrita
            let safe = args.filter { !$0.hasPrefix("-X") && !["--data", "-d", "--output", "-o"].contains($0) }
            guard !safe.isEmpty else { return "Uso: curl <url> [-H header]" }
            return shellRun(["/usr/bin/curl", "-s", "--max-time", "10"] + safe, timeout: 12)

        default:
            return """
            Comando desconhecido: '\(binary)'
            Disponíveis:
              sistema:   ping, sysinfo, storage, battery, network, audit, profile
              arquivos:  ls, cat, find, grep
              macOS:     defaults, brew, diskutil, launchctl, osascript, pmset, system_profiler
              rede:      ssh, curl
              código:    git, claude
            """
        }
    }

    // MARK: - Claude CLI (não-interativo via --print)

    private func runClaudeCLI(args: [String]) -> String {
        let claudeBin = "/Users/maiocchi/.local/bin/claude"

        guard FileManager.default.fileExists(atPath: claudeBin) else {
            return "Claude CLI não encontrado em \(claudeBin)"
        }

        // Bloqueia flags interativas ou perigosas
        let blocked = ["--dangerously-skip-permissions", "--no-verify", "-i", "--interactive"]
        for arg in args {
            if blocked.contains(arg) {
                return "Flag bloqueada: \(arg). Use claude --print '<prompt>'."
            }
        }

        // Se o usuário passou só o prompt sem --print, injeta automaticamente
        var finalArgs = args
        if !finalArgs.contains("--print") && !finalArgs.contains("-p") {
            // Junta tudo como prompt e envolve com --print
            let prompt = args.joined(separator: " ")
            finalArgs = ["--print", prompt]
        }

        // HOME e PATH necessários para o Claude CLI autenticar via ~/.claude/
        var env = ProcessInfo.processInfo.environment
        env["HOME"] = NSHomeDirectory()
        env["PATH"] = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:\(NSHomeDirectory())/.local/bin"

        return shellRunWithEnv([claudeBin] + finalArgs, env: env, timeout: 120)
    }

    // MARK: - macOS built-in command implementations

    private func macSysInfo() -> String {
        let hw = Self.macHWModel()
        let kind = Self.macKindLabel()
        let os = shellRun(["/usr/bin/sw_vers", "-productVersion"], timeout: 3).trimmingCharacters(in: .newlines)
        let hostname = shellRun(["/bin/hostname"], timeout: 3).trimmingCharacters(in: .newlines)
        let cpu = shellRun(["/usr/sbin/sysctl", "-n", "machdep.cpu.brand_string"], timeout: 3).trimmingCharacters(in: .newlines)
        let ram = shellRun(["/usr/sbin/sysctl", "-n", "hw.memsize"], timeout: 3).trimmingCharacters(in: .newlines)
        let ramGB = (Int64(ram) ?? 0) / 1_073_741_824
        return """
        Dispositivo: \(kind) (\(hw))
        Host:        \(hostname)
        macOS:       \(os)
        CPU:         \(cpu)
        RAM:         \(ramGB) GB
        Daemon:      ZeusDaemonMac porta 2223 (Tailscale)
        FoundationModels: \(fmAvailableLabel())
        """
    }

    private func macStorage() -> String {
        let raw = shellRun(["/bin/df", "-h", "/"], timeout: 5)
        return "Armazenamento macOS (/):\n\(raw)"
    }

    private func macBattery() -> String {
        let kind = Self.macKindLabel()
        if kind == "Mac Mini" {
            return "Mac Mini não possui bateria — alimentação direta AC."
        }
        return shellRun(["/usr/bin/pmset", "-g", "batt"], timeout: 5)
    }

    private func macNetwork() -> String {
        let ifaces = shellRun(["/sbin/ifconfig", "-a"], timeout: 5)
        let ts = ifaces.components(separatedBy: "\n")
            .first(where: { $0.contains("100.") && $0.contains("inet ") }) ?? "(Tailscale não detectado)"
        let wifi = shellRun(["/usr/sbin/networksetup", "-getairportnetwork", "en0"], timeout: 5)
        return "Tailscale: \(ts.trimmingCharacters(in: .whitespaces))\nWi-Fi: \(wifi.trimmingCharacters(in: .newlines))"
    }

    private func macAudit() -> String {
        let kind = Self.macKindLabel()
        let hw   = Self.macHWModel()
        let os   = shellRun(["/usr/bin/sw_vers", "-productVersion"], timeout: 3).trimmingCharacters(in: .newlines)
        let uptime = shellRun(["/usr/bin/uptime"], timeout: 3).trimmingCharacters(in: .newlines)
        let fm   = fmAvailableLabel()
        return """
        ═══════════════════════════════════════
          CAPIVARA · AUDITORIA · \(kind.uppercased())
        ═══════════════════════════════════════

        ▶ PERFIL
        DEVICE=\(kind) | HW=\(hw) | OS=macOS \(os)

        ▶ SISTEMA
        Uptime: \(uptime)

        ▶ CAPACIDADES
        SSH (via ZeusDaemonMac porta 2223 · Tailscale)
        NaturalLanguage · Vision · FoundationModels: \(fm)
        Brew · defaults · launchctl · diskutil · osascript

        ▶ RECOMENDAÇÕES
        • profile    — detalhes completos deste Mac
        • storage    — uso de disco
        • battery    — nível da bateria (MacBook)
        • brew list  — pacotes instalados
        • launchctl list — serviços ativos

        Auditoria concluída.
        """
    }

    private func macProfile() -> String {
        let kind = Self.macKindLabel()
        let hw   = Self.macHWModel()
        let os   = shellRun(["/usr/bin/sw_vers", "-productVersion"], timeout: 3).trimmingCharacters(in: .newlines)
        var caps = [
            "macOS · Spotlight · Arquivos (irrestrito no sandbox)",
            "NaturalLanguage · Vision · FoundationModels (\(fmAvailableLabel()))",
            "SSH porta 2222 (se instalado) · HTTP porta 2223 (ZeusDaemonMac)",
            "Homebrew · Terminal · defaults · launchctl · diskutil · osascript"
        ]
        if kind == "MacBook" {
            caps.append("Bateria · Display adaptativo · Camera FaceTime · Magic Trackpad")
        } else if kind == "Mac Mini" {
            caps.append("Sem bateria · Ethernet · Thunderbolt · HDMI · HomePod (se hub)")
        }
        return """
        ── PERFIL CAPIVARA · \(kind) ──
        DEVICE=\(kind) | HW=\(hw) | OS=macOS \(os)
        ── CAPACIDADES ──
        \(caps.joined(separator: "\n"))
        ── COMANDOS RÁPIDOS ──
        audit       — auditoria completa
        sysinfo     — informações do sistema
        storage     — uso de disco
        battery     — bateria (MacBook)
        network     — estado da rede
        brew list   — pacotes Homebrew
        """
    }

    private func fmAvailableLabel() -> String {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            return SystemLanguageModel.default.availability == .available ? "✅ disponível" : "❌ indisponível"
        }
        #endif
        return "❌ requer macOS 26+"
    }

    // MARK: - Shell runner

    private func shellRun(_ args: [String], timeout: TimeInterval = 10) -> String {
        return shellRunWithEnv(args, env: nil, timeout: timeout)
    }

    private func shellRunWithEnv(_ args: [String], env: [String: String]?, timeout: TimeInterval) -> String {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: args[0])
        proc.arguments = Array(args.dropFirst())
        if let env = env {
            proc.environment = env
        }
        let outPipe = Pipe()
        let errPipe = Pipe()
        proc.standardOutput = outPipe
        proc.standardError  = errPipe
        do { try proc.run() } catch {
            return "Erro ao executar \(args[0]): \(error)"
        }
        let sem = DispatchSemaphore(value: 0)
        DispatchQueue.global().async { proc.waitUntilExit(); sem.signal() }
        if sem.wait(timeout: .now() + timeout) == .timedOut {
            proc.terminate()
            return "Timeout após \(Int(timeout))s: \(args.joined(separator: " "))"
        }
        let out = String(data: outPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let err = String(data: errPipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let combined = (out + (err.isEmpty ? "" : "\nSTDERR: \(err)")).trimmingCharacters(in: .newlines)
        return String(combined.prefix(16_384)).isEmpty ? "(sem saída)" : String(combined.prefix(16_384))
    }

    // MARK: - Mac device detection

    static func macHWModel() -> String {
        var size: size_t = 0
        sysctlbyname("hw.model", nil, &size, nil, 0)
        var buf = [CChar](repeating: 0, count: size)
        sysctlbyname("hw.model", &buf, &size, nil, 0)
        return String(cString: buf)
    }

    static func macKindLabel() -> String {
        let hw = macHWModel().lowercased()
        if hw.contains("macmini")   { return "Mac Mini" }
        if hw.contains("macbookpro") { return "MacBook Pro" }
        if hw.contains("macbookair") { return "MacBook Air" }
        if hw.contains("macbook")   { return "MacBook" }
        if hw.contains("macpro")    { return "Mac Pro" }
        if hw.contains("imac")      { return "iMac" }
        return "Mac"
    }

    // MARK: - /v1/passport/extract — Passport Index Architecture (PIA)

    /// Resolve note path: absolute → as-is; relative → vaultURL base; else expand tilde.
    private func resolveNotePath(_ path: String) -> URL {
        if path.hasPrefix("/") {
            return URL(fileURLWithPath: path)
        } else if let base = self.vaultURL {
            return base.appendingPathComponent(path)
        } else {
            return URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        }
    }

    /// Extract concepts via NLTagger (nameType entities + relevant lemmas).
    private func extractConcepts(from text: String, maxConcepts: Int = 12) -> [String] {
        var concepts: [String] = []
        var seen = Set<String>()

        // 1) Named entities (PersonalName, PlaceName, OrganizationName)
        let nameTagger = NLTagger(tagSchemes: [.nameType])
        nameTagger.string = text
        let nameOptions: NLTagger.Options = [.omitPunctuation, .omitWhitespace, .joinNames]
        let interesting: Set<NLTag> = [.personalName, .placeName, .organizationName]
        nameTagger.enumerateTags(in: text.startIndex..<text.endIndex,
                                  unit: .word, scheme: .nameType, options: nameOptions) { tag, range in
            if let t = tag, interesting.contains(t) {
                let token = String(text[range])
                let key = token.lowercased()
                if token.count >= 2 && !seen.contains(key) {
                    seen.insert(key)
                    concepts.append(token)
                }
            }
            return concepts.count < maxConcepts
        }

        // 2) Capitalized non-stopword nouns / camelCase / acronyms via regex fallback
        if concepts.count < maxConcepts {
            let patterns = [
                "\\b[A-Z]{2,}[A-Za-z0-9]*\\b",        // Acronyms: SSH, MCP, NLTagger
                "\\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\\b"  // CamelCase: SwiftNIO, LanguageModelSession
            ]
            for pat in patterns {
                if let re = try? NSRegularExpression(pattern: pat) {
                    let nsText = text as NSString
                    let matches = re.matches(in: text, options: [],
                                              range: NSRange(location: 0, length: nsText.length))
                    for m in matches {
                        let token = nsText.substring(with: m.range)
                        let key = token.lowercased()
                        if !seen.contains(key) && token.count >= 2 {
                            seen.insert(key)
                            concepts.append(token)
                            if concepts.count >= maxConcepts { break }
                        }
                    }
                }
                if concepts.count >= maxConcepts { break }
            }
        }

        return concepts
    }

    /// Heuristic difficulty score 1–5 (no LLM).
    private func computeDifficulty(text: String) -> Int {
        var score = 1
        let charCount = text.count

        if charCount >= 500 { score += 0 } else { return 1 }
        if charCount >= 800 { score += 1 }

        // Markdown code fences (```)
        if text.contains("```") { score += 1 }

        // Technical terminology density
        if let re = try? NSRegularExpression(pattern: "\\b[A-Z]{3,}\\b|\\w+\\(\\)|@\\w+") {
            let nsText = text as NSString
            let matches = re.matches(in: text, options: [],
                                      range: NSRange(location: 0, length: nsText.length))
            if matches.count > 5 { score += 1 }
        }

        // Many wikilinks/markdown links
        let linkPattern = "\\[\\[[^\\]]+\\]\\]|\\[[^\\]]+\\]\\([^\\)]+\\)"
        if let re = try? NSRegularExpression(pattern: linkPattern) {
            let nsText = text as NSString
            let matches = re.matches(in: text, options: [],
                                      range: NSRange(location: 0, length: nsText.length))
            if matches.count > 3 { score += 1 }
        }

        return min(5, max(1, score))
    }

    private struct PassportResult {
        let path: String
        let concepts: [String]
        let oneLineSummary: String
        let domain: [String]
        let difficulty: Int
        let extractedAt: String
        let charCount: Int
    }

    /// Core extraction: text → passport. Returns nil only on FM hard failure.
    private func extractPassportCore(path: String, rawContent: String,
                                      domainOptions: [String]) -> (PassportResult?, String?) {
        // Truncate to 8000 chars to fit FM window
        let truncated = String(rawContent.prefix(8000))

        // 1) Concepts (synchronous, NL only)
        let concepts = self.extractConcepts(from: truncated)

        // 2) Difficulty (pure math)
        let difficulty = self.computeDifficulty(text: truncated)

        // 3 + 4) Summary and domain via FoundationModels
        var oneLineSummary = ""
        var domain: [String] = []

        #if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
            let model = SystemLanguageModel.default
            if case .available = model.availability {
                // 3) Summary
                let sumInstructions = "Resuma em UMA frase de no máximo 25 palavras o texto a seguir. Mantenha o idioma do texto. Responda APENAS com a frase, sem prefixos como 'Resumo:'."
                let sumSession = LanguageModelSession(instructions: sumInstructions)
                let sumOptions = GenerationOptions(temperature: 0.0, maximumResponseTokens: 80)
                let sumSem = DispatchSemaphore(value: 0)
                Task {
                    if let resp = try? await sumSession.respond(to: truncated, options: sumOptions) {
                        oneLineSummary = resp.content.trimmingCharacters(in: .whitespacesAndNewlines)
                    }
                    sumSem.signal()
                }
                _ = sumSem.wait(timeout: .now() + .seconds(30))

                // 4) Domain classification (zero-shot via prompt)
                if !domainOptions.isEmpty {
                    let optionsList = domainOptions.joined(separator: ", ")
                    let clsInstructions = """
                    Classifique o texto a seguir em UMA OU MAIS das categorias permitidas. \
                    Categorias permitidas: \(optionsList). \
                    Responda APENAS um array JSON de strings (subset das categorias). \
                    Sem fences, sem comentários. Exemplo: ["Tecnologia","Pesquisa"]
                    """
                    let clsSession = LanguageModelSession(instructions: clsInstructions)
                    let clsOptions = GenerationOptions(temperature: 0.0, maximumResponseTokens: 120)
                    let clsSem = DispatchSemaphore(value: 0)
                    var clsRaw = ""
                    Task {
                        if let resp = try? await clsSession.respond(to: truncated, options: clsOptions) {
                            clsRaw = resp.content
                        }
                        clsSem.signal()
                    }
                    _ = clsSem.wait(timeout: .now() + .seconds(30))

                    // Parse array
                    if let start = clsRaw.firstIndex(of: "["),
                       let end = clsRaw.lastIndex(of: "]"), start < end {
                        let candidate = String(clsRaw[start...end])
                        if let data = candidate.data(using: .utf8),
                           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String] {
                            // Filter to only allowed options (case-insensitive match)
                            let allowedLower = Set(domainOptions.map { $0.lowercased() })
                            for cat in parsed {
                                if allowedLower.contains(cat.lowercased()) {
                                    // Use canonical case from options
                                    if let canonical = domainOptions.first(where: { $0.lowercased() == cat.lowercased() }) {
                                        if !domain.contains(canonical) {
                                            domain.append(canonical)
                                        }
                                    }
                                }
                            }
                        }
                    }
                    // Fallback: if FM gave nothing, leave domain empty (caller can decide)
                }
            }
        }
        #endif

        // ISO-8601 with milliseconds
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let extractedAt = formatter.string(from: Date())

        let result = PassportResult(
            path: path,
            concepts: concepts,
            oneLineSummary: oneLineSummary,
            domain: domain,
            difficulty: difficulty,
            extractedAt: extractedAt,
            charCount: rawContent.count
        )
        return (result, nil)
    }

    private func passportToDict(_ p: PassportResult, modelVersions: [String: String]) -> [String: Any] {
        return [
            "path": p.path,
            "concepts": p.concepts,
            "one_line_summary": p.oneLineSummary,
            "domain": p.domain,
            "difficulty": p.difficulty,
            "extracted_at": p.extractedAt,
            "char_count": p.charCount,
            "model_versions": modelVersions
        ]
    }

    private func handlePassportExtract(bodyJSON: String) -> Response {
        guard let json = Self.parseJSON(bodyJSON),
              let path = json["path"] as? String, !path.isEmpty else {
            return Response(status: .badRequest, payload: [
                "error": "body inválido: requer {\"path\": \"...\", \"domain_options\": [...]}"
            ])
        }
        let domainOptions = (json["domain_options"] as? [String]) ?? []

        // Resolve content: inline > disk
        var rawContent = (json["content"] as? String) ?? ""
        if rawContent.isEmpty {
            let resolved = self.resolveNotePath(path)
            if let disk = try? String(contentsOf: resolved, encoding: .utf8) {
                rawContent = disk
            } else {
                return Response(status: .badRequest, payload: [
                    "error": "não foi possível ler \(resolved.path)",
                    "path": path
                ])
            }
        }

        let (result, err) = self.extractPassportCore(
            path: path, rawContent: rawContent, domainOptions: domainOptions)
        if let err = err {
            return Response(status: .internalServerError, payload: ["error": err, "path": path])
        }
        guard let p = result else {
            return Response(status: .internalServerError, payload: ["error": "extração falhou", "path": path])
        }

        let modelVersions: [String: String] = [
            "nl": "apple-nlcontextual-pt-BR",
            "afm": "apple-foundationmodels-systemlanguagemodel"
        ]
        return Response(status: .ok, payload: self.passportToDict(p, modelVersions: modelVersions))
    }

    // MARK: - /v1/passport/batch-extract

    private func handlePassportBatchExtract(bodyJSON: String) -> Response {
        guard let json = Self.parseJSON(bodyJSON),
              let paths = json["paths"] as? [String], !paths.isEmpty else {
            return Response(status: .badRequest, payload: [
                "error": "body inválido: requer {\"paths\": [...], \"domain_options\": [...]}"
            ])
        }
        let domainOptions = (json["domain_options"] as? [String]) ?? []

        let modelVersions: [String: String] = [
            "nl": "apple-nlcontextual-pt-BR",
            "afm": "apple-foundationmodels-systemlanguagemodel"
        ]

        let startNs = DispatchTime.now().uptimeNanoseconds
        var passports: [[String: Any]] = []
        var errors: [[String: String]] = []

        for path in paths {
            let resolved = self.resolveNotePath(path)
            guard let raw = try? String(contentsOf: resolved, encoding: .utf8) else {
                errors.append(["path": path, "error": "não foi possível ler \(resolved.path)"])
                continue
            }
            let (result, coreErr) = self.extractPassportCore(
                path: path, rawContent: raw, domainOptions: domainOptions)
            if let coreErr = coreErr {
                errors.append(["path": path, "error": coreErr])
                continue
            }
            if let p = result {
                passports.append(self.passportToDict(p, modelVersions: modelVersions))
            } else {
                errors.append(["path": path, "error": "extração falhou"])
            }
        }

        let elapsedNs = DispatchTime.now().uptimeNanoseconds - startNs
        let elapsedMs = Int(elapsedNs / 1_000_000)

        return Response(status: .ok, payload: [
            "passports": passports,
            "errors": errors,
            "count": passports.count,
            "error_count": errors.count,
            "elapsed_ms": elapsedMs
        ])
    }

    // MARK: - /v1/passport/find — orquestra cosine + filter, retorna cards sem content

    /// Embed text via NLContextualEmbedding (pooled vector). Returns nil if unavailable.
    private func embedQuerySync(_ text: String) -> [Float]? {
        if #available(macOS 14.0, *) {
            let langs: [NLLanguage] = [.portuguese, .english]
            for lang in langs {
                guard let emb = NLContextualEmbedding(language: lang) else { continue }
                if !emb.hasAvailableAssets {
                    _ = try? emb.load()
                }
                if let result = try? emb.embeddingResult(for: text, language: lang) {
                    var vector: [Float] = []
                    var tokenCount: Int = 0
                    result.enumerateTokenVectors(in: text.startIndex..<text.endIndex) { vec, _ in
                        if !vec.isEmpty {
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
                    if !vector.isEmpty {
                        let count = max(1, tokenCount)
                        return vector.map { $0 / Float(count) }
                    }
                }
            }
        }
        if let emb = NLEmbedding.sentenceEmbedding(for: .portuguese)
            ?? NLEmbedding.sentenceEmbedding(for: .english),
           let vec = emb.vector(for: text) {
            return vec.map { Float($0) }
        }
        return nil
    }

    private static func cosineSimilarity(_ a: [Float], _ b: [Float]) -> Float {
        let n = min(a.count, b.count)
        guard n > 0 else { return 0 }
        var dot: Float = 0
        var na: Float = 0
        var nb: Float = 0
        for i in 0..<n {
            dot += a[i] * b[i]
            na += a[i] * a[i]
            nb += b[i] * b[i]
        }
        let denom = (na.squareRoot()) * (nb.squareRoot())
        return denom > 0 ? dot / denom : 0
    }

    private func handlePassportFind(bodyJSON: String) -> Response {
        guard let json = Self.parseJSON(bodyJSON),
              let query = json["query"] as? String, !query.isEmpty,
              let embPath = json["embeddings_jsonl_path"] as? String,
              let pasPath = json["passports_jsonl_path"] as? String else {
            return Response(status: .badRequest, payload: [
                "error": "body inválido: requer query, embeddings_jsonl_path, passports_jsonl_path"
            ])
        }
        let topN = (json["top_n"] as? Int) ?? 10
        let minScore = (json["min_score"] as? Double).map { Float($0) } ?? 0.3
        let conceptFilter = (json["concept_filter"] as? [String]) ?? []

        // Load JSONL files
        let embURL = URL(fileURLWithPath: (embPath as NSString).expandingTildeInPath)
        let pasURL = URL(fileURLWithPath: (pasPath as NSString).expandingTildeInPath)

        guard let embRaw = try? String(contentsOf: embURL, encoding: .utf8) else {
            return Response(status: .badRequest, payload: ["error": "não foi possível ler embeddings em \(embPath)"])
        }
        guard let pasRaw = try? String(contentsOf: pasURL, encoding: .utf8) else {
            return Response(status: .badRequest, payload: ["error": "não foi possível ler passaportes em \(pasPath)"])
        }

        // Build passport index by path
        var passportByPath: [String: [String: Any]] = [:]
        for line in pasRaw.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }
            guard let data = trimmed.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let path = obj["path"] as? String else { continue }
            passportByPath[path] = obj
        }

        // Embed query
        guard let queryVec = self.embedQuerySync(query) else {
            return Response(status: .internalServerError, payload: ["error": "embedding indisponível"])
        }

        // Score against each embedding
        struct Candidate {
            let path: String
            let cosine: Float
        }
        var candidates: [Candidate] = []
        for line in embRaw.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }
            guard let data = trimmed.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let path = obj["path"] as? String,
                  let vecAny = obj["vector"] as? [Any] else { continue }
            let vec: [Float] = vecAny.compactMap { ($0 as? NSNumber).map { Float(truncating: $0) } }
            if vec.isEmpty { continue }
            let score = Self.cosineSimilarity(queryVec, vec)
            if score >= minScore {
                candidates.append(Candidate(path: path, cosine: score))
            }
        }

        // Sort and take top-N*2 for filtering headroom
        candidates.sort { $0.cosine > $1.cosine }
        let pool = Array(candidates.prefix(topN * 2))

        // Apply concept filter + build result cards
        let filterLower = Set(conceptFilter.map { $0.lowercased() })
        var results: [[String: Any]] = []
        var totalBytes = 0
        var wouldBeBytes = 0

        for cand in pool {
            guard let passport = passportByPath[cand.path] else { continue }
            let concepts = (passport["concepts"] as? [String]) ?? []
            let conceptsLower = Set(concepts.map { $0.lowercased() })

            let overlap: [String]
            if !filterLower.isEmpty {
                overlap = concepts.filter { filterLower.contains($0.lowercased()) }
                if overlap.isEmpty { continue } // filter strict
            } else {
                // Compute overlap with query tokens for ranking hint
                let queryTokens = Set(query.lowercased().split(separator: " ").map(String.init))
                overlap = concepts.filter { queryTokens.contains($0.lowercased()) || conceptsLower.contains($0.lowercased()) && queryTokens.contains($0.lowercased()) }
            }

            // Boost score by overlap count
            let boostedScore = cand.cosine * (1.0 + 0.2 * Float(overlap.count))

            let card: [String: Any] = [
                "path": cand.path,
                "cosine_score": cand.cosine,
                "score": boostedScore,
                "concepts": concepts,
                "one_line_summary": passport["one_line_summary"] ?? "",
                "domain": passport["domain"] ?? [],
                "difficulty": passport["difficulty"] ?? 0,
                "concept_overlap": overlap
            ]
            results.append(card)

            // Token-saving metrics: estimate card size vs char_count
            if let cardData = try? JSONSerialization.data(withJSONObject: card) {
                totalBytes += cardData.count
            }
            if let cc = passport["char_count"] as? Int {
                wouldBeBytes += cc
            }

            if results.count >= topN { break }
        }

        // Re-sort by boosted score
        results.sort { (($0["score"] as? Float) ?? 0) > (($1["score"] as? Float) ?? 0) }

        return Response(status: .ok, payload: [
            "query": query,
            "results": results,
            "count": results.count,
            "total_bytes_returned": totalBytes,
            "would_be_bytes_full_content": wouldBeBytes,
            "savings_ratio": wouldBeBytes > 0 ? Double(wouldBeBytes - totalBytes) / Double(wouldBeBytes) : 0.0
        ])
    }

    // MARK: - /v1/content/get — on-demand fetcher

    private func handleContentGet(bodyJSON: String) -> Response {
        guard let json = Self.parseJSON(bodyJSON),
              let path = json["path"] as? String, !path.isEmpty else {
            return Response(status: .badRequest, payload: [
                "error": "body inválido: requer {\"path\": \"...\", \"vault_root\"?: \"...\", \"max_chars\"?: N}"
            ])
        }
        let maxChars = (json["max_chars"] as? Int) ?? 50_000
        let vaultRootOpt = json["vault_root"] as? String

        // Resolve URL: prefer explicit vault_root, then absolute, then self.vaultURL
        let resolved: URL
        if path.hasPrefix("/") {
            resolved = URL(fileURLWithPath: path)
        } else if let vr = vaultRootOpt, !vr.isEmpty {
            let base = URL(fileURLWithPath: (vr as NSString).expandingTildeInPath)
            resolved = base.appendingPathComponent(path)
        } else if let base = self.vaultURL {
            resolved = base.appendingPathComponent(path)
        } else {
            resolved = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        }

        guard let raw = try? String(contentsOf: resolved, encoding: .utf8) else {
            return Response(status: .badRequest, payload: [
                "error": "não foi possível ler \(resolved.path)",
                "path": path
            ])
        }

        let truncated = String(raw.prefix(maxChars))

        // Parse YAML frontmatter (between leading --- markers)
        var frontmatter: [String: Any] = [:]
        if raw.hasPrefix("---\n") {
            let afterFirst = raw.index(raw.startIndex, offsetBy: 4)
            if let endRange = raw.range(of: "\n---\n", range: afterFirst..<raw.endIndex) ??
                              raw.range(of: "\n---", range: afterFirst..<raw.endIndex) {
                let block = String(raw[afterFirst..<endRange.lowerBound])
                for line in block.split(separator: "\n") {
                    let lineStr = String(line)
                    if let colonIdx = lineStr.firstIndex(of: ":") {
                        let key = String(lineStr[..<colonIdx]).trimmingCharacters(in: .whitespaces)
                        let valRaw = String(lineStr[lineStr.index(after: colonIdx)...]).trimmingCharacters(in: .whitespaces)
                        // Try to parse as array, number, bool, else string
                        if valRaw.hasPrefix("[") && valRaw.hasSuffix("]") {
                            let inner = String(valRaw.dropFirst().dropLast())
                            let items = inner.split(separator: ",").map {
                                $0.trimmingCharacters(in: CharacterSet(charactersIn: " \"'"))
                            }
                            frontmatter[key] = items
                        } else if valRaw == "true" {
                            frontmatter[key] = true
                        } else if valRaw == "false" {
                            frontmatter[key] = false
                        } else if let n = Int(valRaw) {
                            frontmatter[key] = n
                        } else if let d = Double(valRaw) {
                            frontmatter[key] = d
                        } else {
                            frontmatter[key] = valRaw.trimmingCharacters(in: CharacterSet(charactersIn: "\"'"))
                        }
                    }
                }
            }
        }

        return Response(status: .ok, payload: [
            "path": path,
            "resolved_path": resolved.path,
            "content": truncated,
            "char_count": truncated.count,
            "full_char_count": raw.count,
            "truncated": raw.count > maxChars,
            "frontmatter": frontmatter
        ])
    }

    // MARK: - FoundationModels runner (gated)

    private func runFoundationModel(
        instructions: String,
        prompt: String,
        maxTokens: Int,
        extraPayload: [String: Any]
    ) -> Response {
        #if canImport(FoundationModels)
        if #available(macOS 26.0, *) {
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
                "error": "FoundationModels requer macOS 26.0+ (esta máquina é mais antiga)"
            ])
        }
        #else
        return Response(status: .serviceUnavailable, payload: [
            "error": "FoundationModels framework não disponível neste build (compilar em macOS 26+ SDK)"
        ])
        #endif
    }

    // MARK: - v0.5 recovered v0.7 endpoints — full Apple ecosystem coverage

    // ------ helper: load CGImage from path ------
    #if canImport(Vision)
    private func loadCGImage(from path: String) -> CGImage? {
        let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        guard let data = try? Data(contentsOf: url),
              let src = CGImageSourceCreateWithData(data as CFData, nil),
              let cgImage = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
            return nil
        }
        return cgImage
    }
    #endif

    // MARK: - /v1/translate (Apple Translation framework, macOS 15+)
    private func handleTranslate(bodyJSON: String) -> Response {
        guard let json = Self.parseJSON(bodyJSON),
              let text = json["text"] as? String, !text.isEmpty else {
            return Response(status: .badRequest, payload: [
                "error": "body inválido: requer {\"text\": \"...\", \"source_lang\": \"pt\", \"target_lang\": \"en\"}"
            ])
        }
        let sourceLang = (json["source_lang"] as? String) ?? "pt"
        let targetLang = (json["target_lang"] as? String) ?? "en"

        #if canImport(Translation)
        if #available(macOS 26.0, *) {
            let sem = DispatchSemaphore(value: 0)
            var translated: String = ""
            var errMsg: String? = nil
            Task {
                do {
                    let session = TranslationSession(installedSource: Locale.Language(identifier: sourceLang),
                                                     target: Locale.Language(identifier: targetLang))
                    let resp = try await session.translate(text)
                    translated = resp.targetText
                } catch {
                    errMsg = "\(error)"
                }
                sem.signal()
            }
            _ = sem.wait(timeout: .now() + .seconds(30))
            if let err = errMsg {
                return Response(status: .internalServerError, payload: [
                    "error": "Translation falhou: \(err)",
                    "note": "TranslationSession headless pode exigir modelos pré-baixados via Settings → Languages & Region → Translation"
                ])
            }
            return Response(status: .ok, payload: [
                "translated_text": translated,
                "source_lang": sourceLang,
                "target_lang": targetLang,
                "model": "apple-translation-framework"
            ])
        }
        #endif
        return Response(status: .serviceUnavailable, payload: [
            "error": "Translation programática headless requer macOS 26+ (em versões anteriores Translation exige UI SwiftUI .translationTask)",
            "fallback_hint": "Use afm CLI ou outro provedor para texto em pre-26"
        ])
    }

    // MARK: - /v1/nl/tag (NLTagger lemma / nameType / lexicalClass / tokenType)
    private func handleNLTag(bodyJSON: String) -> Response {
        guard let json = Self.parseJSON(bodyJSON),
              let text = json["text"] as? String, !text.isEmpty else {
            return Response(status: .badRequest, payload: [
                "error": "body inválido: requer {\"text\": \"...\", \"scheme\": \"lemma|nameType|lexicalClass|tokenType\"}"
            ])
        }
        let schemeStr = (json["scheme"] as? String) ?? "lemma"
        let scheme: NLTagScheme
        switch schemeStr {
        case "nameType":      scheme = .nameType
        case "lexicalClass":  scheme = .lexicalClass
        case "tokenType":     scheme = .tokenType
        case "language":      scheme = .language
        case "script":        scheme = .script
        case "sentimentScore": scheme = .sentimentScore
        case "nameTypeOrLexicalClass": scheme = .nameTypeOrLexicalClass
        default:              scheme = .lemma
        }

        let tagger = NLTagger(tagSchemes: [scheme])
        tagger.string = text

        var tokens: [[String: Any]] = []
        let range = text.startIndex..<text.endIndex
        let unit: NLTokenUnit = (scheme == .sentimentScore) ? .paragraph : .word
        tagger.enumerateTags(in: range, unit: unit, scheme: scheme,
                             options: [.omitWhitespace, .omitPunctuation]) { tag, tokenRange in
            let token = String(text[tokenRange])
            var dict: [String: Any] = ["token": token]
            if let tag = tag {
                dict["tag"] = tag.rawValue
            }
            tokens.append(dict)
            return true
        }
        return Response(status: .ok, payload: [
            "tokens": tokens,
            "scheme": schemeStr,
            "count": tokens.count,
            "model": "apple-nltagger"
        ])
    }

    // MARK: - /v1/nl/sentiment (NLTagger .sentimentScore)
    private func handleNLSentiment(bodyJSON: String) -> Response {
        guard let json = Self.parseJSON(bodyJSON),
              let text = json["text"] as? String, !text.isEmpty else {
            return Response(status: .badRequest, payload: [
                "error": "body inválido: requer {\"text\": \"...\"}"
            ])
        }
        let tagger = NLTagger(tagSchemes: [.sentimentScore])
        tagger.string = text
        var scores: [Double] = []
        tagger.enumerateTags(in: text.startIndex..<text.endIndex, unit: .paragraph,
                             scheme: .sentimentScore, options: []) { tag, _ in
            if let raw = tag?.rawValue, let v = Double(raw) {
                scores.append(v)
            }
            return true
        }
        let avg = scores.isEmpty ? 0.0 : scores.reduce(0, +) / Double(scores.count)
        let label: String
        if avg >  0.2 { label = "positive" }
        else if avg < -0.2 { label = "negative" }
        else { label = "neutral" }
        return Response(status: .ok, payload: [
            "sentiment_score": avg,
            "label": label,
            "paragraph_scores": scores,
            "paragraph_count": scores.count,
            "model": "apple-nltagger-sentimentScore"
        ])
    }

    // MARK: - /v1/nl/language-detect (NLLanguageRecognizer)
    private func handleNLLanguageDetect(bodyJSON: String) -> Response {
        guard let json = Self.parseJSON(bodyJSON),
              let text = json["text"] as? String, !text.isEmpty else {
            return Response(status: .badRequest, payload: [
                "error": "body inválido: requer {\"text\": \"...\"}"
            ])
        }
        let topN = (json["top_n"] as? Int) ?? 3
        let recog = NLLanguageRecognizer()
        recog.processString(text)
        let dominant = recog.dominantLanguage?.rawValue ?? "und"
        let hyps = recog.languageHypotheses(withMaximum: topN)
        let hypArr: [[String: Any]] = hyps.map { (lang, prob) in
            ["language": lang.rawValue, "probability": prob]
        }.sorted { ($0["probability"] as? Double ?? 0) > ($1["probability"] as? Double ?? 0) }
        return Response(status: .ok, payload: [
            "dominant_language": dominant,
            "hypotheses": hypArr,
            "model": "apple-nllanguagerecognizer"
        ])
    }

    // MARK: - /v1/vision/saliency (VNGenerateAttentionBasedSaliencyImageRequest)
    private func handleVisionSaliency(bodyJSON: String) -> Response {
        #if !canImport(Vision)
        return Response(status: .serviceUnavailable, payload: ["error": "Vision framework indisponível neste build"])
        #else
        guard let json = Self.parseJSON(bodyJSON),
              let path = json["path"] as? String, !path.isEmpty else {
            return Response(status: .badRequest, payload: [
                "error": "body inválido: requer {\"path\": \"...\", \"mode\": \"attention|objectness\"}"
            ])
        }
        let mode = (json["mode"] as? String) ?? "attention"
        guard let cgImage = self.loadCGImage(from: path) else {
            return Response(status: .badRequest, payload: ["error": "não foi possível ler/decodificar imagem em \(path)"])
        }
        let request: VNRequest = (mode == "objectness")
            ? VNGenerateObjectnessBasedSaliencyImageRequest()
            : VNGenerateAttentionBasedSaliencyImageRequest()
        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        do { try handler.perform([request]) }
        catch { return Response(status: .internalServerError, payload: ["error": "Vision falhou: \(error)"]) }

        var salientObjects: [[String: Any]] = []
        if let obs = request.results?.first as? VNSaliencyImageObservation,
           let objects = obs.salientObjects {
            for o in objects {
                salientObjects.append([
                    "boundingBox": [
                        "x": Double(o.boundingBox.origin.x),
                        "y": Double(o.boundingBox.origin.y),
                        "width": Double(o.boundingBox.size.width),
                        "height": Double(o.boundingBox.size.height)
                    ],
                    "confidence": Float(o.confidence)
                ])
            }
        }
        return Response(status: .ok, payload: [
            "salient_objects": salientObjects,
            "count": salientObjects.count,
            "mode": mode,
            "path": path,
            "model": "Vision VNGenerate\(mode == "objectness" ? "Objectness" : "Attention")BasedSaliencyImageRequest"
        ])
        #endif
    }

    // MARK: - /v1/vision/feature-print (VNGenerateImageFeaturePrintRequest)
    private func handleVisionFeaturePrint(bodyJSON: String) -> Response {
        #if !canImport(Vision)
        return Response(status: .serviceUnavailable, payload: ["error": "Vision framework indisponível neste build"])
        #else
        guard let json = Self.parseJSON(bodyJSON),
              let path = json["path"] as? String, !path.isEmpty else {
            return Response(status: .badRequest, payload: ["error": "body inválido: requer {\"path\": \"...\"}"])
        }
        guard let cgImage = self.loadCGImage(from: path) else {
            return Response(status: .badRequest, payload: ["error": "não foi possível ler/decodificar imagem em \(path)"])
        }
        let request = VNGenerateImageFeaturePrintRequest()
        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        do { try handler.perform([request]) }
        catch { return Response(status: .internalServerError, payload: ["error": "Vision falhou: \(error)"]) }

        guard let obs = request.results?.first as? VNFeaturePrintObservation else {
            return Response(status: .internalServerError, payload: ["error": "sem feature print"])
        }
        let elementCount = obs.elementCount
        let dataSize = obs.data.count
        let elementType = obs.elementType
        // Element type: 1 = float, 2 = float16. Extract as Float array.
        var vector: [Float] = []
        if elementType == .float {
            let raw = obs.data
            raw.withUnsafeBytes { rawBuf in
                let p = rawBuf.bindMemory(to: Float.self)
                vector = Array(p.prefix(elementCount))
            }
        } else if elementType == .double {
            let raw = obs.data
            raw.withUnsafeBytes { rawBuf in
                let p = rawBuf.bindMemory(to: Double.self)
                vector = p.prefix(elementCount).map { Float($0) }
            }
        }
        return Response(status: .ok, payload: [
            "vector": vector,
            "dim": vector.count,
            "element_count": elementCount,
            "data_size": dataSize,
            "element_type": (elementType == .float) ? "float" : ((elementType == .double) ? "double" : "unknown"),
            "path": path,
            "model": "Vision VNGenerateImageFeaturePrintRequest"
        ])
        #endif
    }

    // MARK: - /v1/vision/aesthetics (VNCalculateImageAestheticsScoresRequest, macOS 15+)
    private func handleVisionAesthetics(bodyJSON: String) -> Response {
        #if !canImport(Vision)
        return Response(status: .serviceUnavailable, payload: ["error": "Vision framework indisponível neste build"])
        #else
        guard let json = Self.parseJSON(bodyJSON),
              let path = json["path"] as? String, !path.isEmpty else {
            return Response(status: .badRequest, payload: ["error": "body inválido: requer {\"path\": \"...\"}"])
        }
        guard let cgImage = self.loadCGImage(from: path) else {
            return Response(status: .badRequest, payload: ["error": "não foi possível ler/decodificar imagem em \(path)"])
        }
        if #available(macOS 15.0, *) {
            let request = VNCalculateImageAestheticsScoresRequest()
            let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
            do { try handler.perform([request]) }
            catch { return Response(status: .internalServerError, payload: ["error": "Vision falhou: \(error)"]) }
            guard let obs = request.results?.first as? VNImageAestheticsScoresObservation else {
                return Response(status: .internalServerError, payload: ["error": "sem observação aesthetics"])
            }
            return Response(status: .ok, payload: [
                "overall_score": Float(obs.overallScore),
                "is_utility": obs.isUtility,
                "path": path,
                "model": "Vision VNCalculateImageAestheticsScoresRequest"
            ])
        }
        return Response(status: .serviceUnavailable, payload: [
            "error": "VNCalculateImageAestheticsScoresRequest requer macOS 15+"
        ])
        #endif
    }

    // MARK: - /v1/vision/barcode (VNDetectBarcodesRequest)
    private func handleVisionBarcode(bodyJSON: String) -> Response {
        #if !canImport(Vision)
        return Response(status: .serviceUnavailable, payload: ["error": "Vision framework indisponível neste build"])
        #else
        guard let json = Self.parseJSON(bodyJSON),
              let path = json["path"] as? String, !path.isEmpty else {
            return Response(status: .badRequest, payload: ["error": "body inválido: requer {\"path\": \"...\"}"])
        }
        guard let cgImage = self.loadCGImage(from: path) else {
            return Response(status: .badRequest, payload: ["error": "não foi possível ler/decodificar imagem em \(path)"])
        }
        let request = VNDetectBarcodesRequest()
        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        do { try handler.perform([request]) }
        catch { return Response(status: .internalServerError, payload: ["error": "Vision falhou: \(error)"]) }

        let observations = request.results ?? []
        var barcodes: [[String: Any]] = []
        for obs in observations {
            var dict: [String: Any] = [
                "payload": obs.payloadStringValue ?? "",
                "symbology": obs.symbology.rawValue,
                "confidence": Float(obs.confidence),
                "boundingBox": [
                    "x": Double(obs.boundingBox.origin.x),
                    "y": Double(obs.boundingBox.origin.y),
                    "width": Double(obs.boundingBox.size.width),
                    "height": Double(obs.boundingBox.size.height)
                ]
            ]
            if #available(macOS 12.0, *) {
                if let payloadData = obs.payloadData {
                    dict["payload_bytes_size"] = payloadData.count
                }
            }
            barcodes.append(dict)
        }
        return Response(status: .ok, payload: [
            "barcodes": barcodes,
            "count": barcodes.count,
            "path": path,
            "model": "Vision VNDetectBarcodesRequest"
        ])
        #endif
    }

    // MARK: - /v1/vision/document (VNRecognizeDocumentsRequest, macOS 15+; falls back to OCR layout)
    private func handleVisionDocument(bodyJSON: String) -> Response {
        #if !canImport(Vision)
        return Response(status: .serviceUnavailable, payload: ["error": "Vision framework indisponível neste build"])
        #else
        guard let json = Self.parseJSON(bodyJSON),
              let path = json["path"] as? String, !path.isEmpty else {
            return Response(status: .badRequest, payload: ["error": "body inválido: requer {\"path\": \"...\"}"])
        }
        guard let cgImage = self.loadCGImage(from: path) else {
            return Response(status: .badRequest, payload: ["error": "não foi possível ler/decodificar imagem em \(path)"])
        }
        // Layout-aware fallback usando VNRecognizeTextRequest + boundingBox por linha.
        // VNRecognizeDocumentsRequest está disponível apenas em macOS 26+ e via API async.
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        if #available(macOS 13.0, *) {
            request.recognitionLanguages = ["pt-BR", "en-US"]
        }
        let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
        do { try handler.perform([request]) }
        catch { return Response(status: .internalServerError, payload: ["error": "Vision falhou: \(error)"]) }

        let observations = request.results ?? []
        var blocks: [[String: Any]] = []
        for obs in observations {
            guard let top = obs.topCandidates(1).first else { continue }
            blocks.append([
                "text": top.string,
                "confidence": Float(top.confidence),
                "boundingBox": [
                    "x": Double(obs.boundingBox.origin.x),
                    "y": Double(obs.boundingBox.origin.y),
                    "width": Double(obs.boundingBox.size.width),
                    "height": Double(obs.boundingBox.size.height)
                ]
            ])
        }
        return Response(status: .ok, payload: [
            "blocks": blocks,
            "block_count": blocks.count,
            "full_text": blocks.compactMap { $0["text"] as? String }.joined(separator: "\n"),
            "path": path,
            "model": "Vision VNRecognizeTextRequest (layout-aware fallback for document)"
        ])
        #endif
    }

    // MARK: - /v1/data-detect (NSDataDetector URLs/phones/dates/addresses)
    private func handleDataDetect(bodyJSON: String) -> Response {
        guard let json = Self.parseJSON(bodyJSON),
              let text = json["text"] as? String, !text.isEmpty else {
            return Response(status: .badRequest, payload: ["error": "body inválido: requer {\"text\": \"...\"}"])
        }
        let types: NSTextCheckingResult.CheckingType = [.link, .phoneNumber, .date, .address]
        guard let detector = try? NSDataDetector(types: types.rawValue) else {
            return Response(status: .internalServerError, payload: ["error": "NSDataDetector falhou ao inicializar"])
        }
        let matches = detector.matches(in: text, options: [], range: NSRange(location: 0, length: (text as NSString).length))
        var results: [[String: Any]] = []
        for m in matches {
            var dict: [String: Any] = [
                "range_location": m.range.location,
                "range_length": m.range.length,
                "value": (text as NSString).substring(with: m.range)
            ]
            if m.resultType == .link, let url = m.url { dict["type"] = "link"; dict["url"] = url.absoluteString }
            else if m.resultType == .phoneNumber, let p = m.phoneNumber { dict["type"] = "phone"; dict["phone"] = p }
            else if m.resultType == .date, let d = m.date { dict["type"] = "date"; dict["date"] = ISO8601DateFormatter().string(from: d) }
            else if m.resultType == .address, let comps = m.addressComponents {
                dict["type"] = "address"
                var addr: [String: String] = [:]
                for (k, v) in comps { addr[k.rawValue] = v }
                dict["address"] = addr
            }
            results.append(dict)
        }
        return Response(status: .ok, payload: [
            "matches": results,
            "count": results.count,
            "model": "Foundation NSDataDetector"
        ])
    }

    // MARK: - /v1/spotlight/search (mdfind shell bridge)
    private func handleSpotlightSearch(bodyJSON: String) -> Response {
        guard let json = Self.parseJSON(bodyJSON),
              let query = json["query"] as? String, !query.isEmpty else {
            return Response(status: .badRequest, payload: [
                "error": "body inválido: requer {\"query\": \"...\", \"scope\": \"opcional\", \"limit\": 50}"
            ])
        }
        let limit = (json["limit"] as? Int) ?? 50
        let scope = json["scope"] as? String

        var args: [String] = []
        if let s = scope, !s.isEmpty {
            args.append("-onlyin")
            args.append((s as NSString).expandingTildeInPath)
        }
        args.append(query)

        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/mdfind")
        task.arguments = args
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = Pipe()
        do {
            try task.run()
            task.waitUntilExit()
        } catch {
            return Response(status: .internalServerError, payload: ["error": "mdfind falhou: \(error)"])
        }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let str = String(data: data, encoding: .utf8) ?? ""
        let allPaths = str.split(separator: "\n").map(String.init).filter { !$0.isEmpty }
        let limited = Array(allPaths.prefix(limit))
        return Response(status: .ok, payload: [
            "query": query,
            "scope": scope ?? NSNull(),
            "results": limited,
            "count": limited.count,
            "total_found": allPaths.count,
            "exit_code": task.terminationStatus,
            "model": "macOS mdfind (Spotlight)"
        ])
    }

    // MARK: - Helpers

    private static func parseJSON(_ s: String) -> [String: Any]? {
        guard let data = s.data(using: .utf8) else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private static func extractJSON(from raw: String) -> [String: Any]? {
        if let direct = parseJSON(raw) { return direct }
        guard let start = raw.firstIndex(of: "{"),
              let end = raw.lastIndex(of: "}"), start < end else { return nil }
        let candidate = String(raw[start...end])
        return parseJSON(candidate)
    }

    private func writeJSON(context: ChannelHandlerContext, status: HTTPResponseStatus, dict: [String: Any]) {
        var headers = HTTPHeaders()
        headers.add(name: "Content-Type", value: "application/json; charset=utf-8")
        headers.add(name: "Access-Control-Allow-Origin", value: "*")
        headers.add(name: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS")
        headers.add(name: "Access-Control-Allow-Headers", value: "Content-Type")
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

    func errorCaught(context: ChannelHandlerContext, error: Error) {
        FileHandle.standardError.write("[ZeusMacHTTPHandler] error: \(error)\n".data(using: .utf8) ?? Data())
        context.close(promise: nil)
    }
}
