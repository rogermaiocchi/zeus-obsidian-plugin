import Foundation
import NIOCore
import NIOHTTP1
import NaturalLanguage
import CryptoKit
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
#if canImport(Speech)
import Speech
#endif
#if canImport(AVFoundation)
import AVFoundation
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
        case (.POST, "/v1/passport/extract"):
            return self.handlePassportExtract(bodyJSON: body)
        case (.POST, "/v1/passport/batch-extract"):
            return self.handlePassportBatchExtract(bodyJSON: body)
        case (.POST, "/v1/passport/find"):
            return self.handlePassportFind(bodyJSON: body)
        case (.POST, "/v1/content/get"):
            return self.handleContentGet(bodyJSON: body)
        case (.POST, "/v1/passport/claim"):
            return self.handlePassportClaim(bodyJSON: body)
        case (.POST, "/v1/passport/release"):
            return self.handlePassportRelease(bodyJSON: body)
        // v1.3 — afm refine (Writing Tools nativo via FoundationModels)
        case (.POST, "/v1/afm/refine"):
            return self.handleRefine(bodyJSON: body)
        // v1.3 — asp transcribe (dual-engine SA + SF fallback)
        case (.POST, "/v1/asp/transcribe"):
            return self.handleASPTranscribe(bodyJSON: body)
        case (.POST, "/v1/asp/vad"):
            return self.handleASPVAD(bodyJSON: body)
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
                    "POST /v1/vision/classify", "POST /v1/vision/landmarks",
                    "POST /v1/passport/extract", "POST /v1/passport/batch-extract",
                    "POST /v1/passport/find", "POST /v1/content/get",
                    "POST /v1/passport/claim", "POST /v1/passport/release",
                    "POST /v1/afm/refine",
                    "POST /v1/asp/transcribe", "POST /v1/asp/vad"
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

        var speechAvailable = false
        #if canImport(Speech)
        speechAvailable = true
        #endif

        #if os(iOS)
        let platform = "iOS"
        #elseif os(macOS)
        let platform = "macOS"
        #else
        let platform = "unknown"
        #endif

        let endpoints = [
            "GET /v1/health", "GET /v1/tools",
            "POST /v1/embed", "POST /v1/ocr",
            "POST /v1/summarize", "POST /v1/enrich",
            "POST /v1/agent", "POST /v1/prompt",
            "POST /v1/cmd",
            "POST /v1/vision/classify", "POST /v1/vision/landmarks",
            "POST /v1/passport/extract", "POST /v1/passport/batch-extract",
            "POST /v1/passport/find", "POST /v1/content/get",
            "POST /v1/passport/claim", "POST /v1/passport/release",
            "POST /v1/afm/refine",
            "POST /v1/asp/transcribe", "POST /v1/asp/vad"
        ]
        return [
            "status": "ok",
            "fm_available": fmAvailable,
            "nl_available": nlAvailable,
            "vision_available": visionAvailable,
            "speech_available": speechAvailable,
            "model": modelName,
            "version": "0.3.0",
            "platform": platform,
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
                ["name": "agent", "endpoint": "POST /v1/agent", "input": "question + pattern",
                 "output": "answer", "model": "AegisClaudeAgent (FoundationModels)"],
                ["name": "prompt", "endpoint": "POST /v1/prompt", "input": "instruction",
                 "output": "generated text", "model": "FoundationModels LanguageModelSession"],
                ["name": "cmd", "endpoint": "POST /v1/cmd", "input": "cmd",
                 "output": "output", "model": "iOS native (ping/status/audit/network/storage/sysinfo/spotlight/health/contacts/calendar/reminders/photos/ls)"],
                ["name": "vision_classify", "endpoint": "POST /v1/vision/classify", "input": "path + top_n",
                 "output": "classifications [{label, confidence}]", "model": "Vision VNClassifyImageRequest"],
                ["name": "vision_landmarks", "endpoint": "POST /v1/vision/landmarks", "input": "path",
                 "output": "faces with landmarks + count", "model": "Vision VNDetectFaceLandmarksRequest"],
                ["name": "passport_extract", "endpoint": "POST /v1/passport/extract",
                 "input": "path + content? + domain_options",
                 "output": "passport (concepts, summary, domain, difficulty)", "model": "NLTagger + FoundationModels"],
                ["name": "passport_batch_extract", "endpoint": "POST /v1/passport/batch-extract",
                 "input": "paths[] + domain_options",
                 "output": "passports[] + errors[]", "model": "NLTagger + FoundationModels"],
                ["name": "passport_find", "endpoint": "POST /v1/passport/find",
                 "input": "query + embeddings_jsonl_path + passports_jsonl_path",
                 "output": "ranked cards (no content) with cosine + concept overlap",
                 "model": "NLContextualEmbedding cosine"],
                ["name": "content_get", "endpoint": "POST /v1/content/get",
                 "input": "path + vault_root? + max_chars?",
                 "output": "content + frontmatter", "model": "FileManager"],
                ["name": "passport_claim", "endpoint": "POST /v1/passport/claim",
                 "input": "note_path + vault_root + device_id + ttl_seconds",
                 "output": "{claimed, current_holder, claimed_at, expires_at}",
                 "model": "filesystem lock (sha256 path) — coordenação cross-device via iCloud"],
                ["name": "passport_release", "endpoint": "POST /v1/passport/release",
                 "input": "note_path + vault_root + device_id",
                 "output": "{released, reason}",
                 "model": "filesystem lock"]
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

        if concepts.count < maxConcepts {
            let patterns = [
                "\\b[A-Z]{2,}[A-Za-z0-9]*\\b",
                "\\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\\b"
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

        if text.contains("```") { score += 1 }

        if let re = try? NSRegularExpression(pattern: "\\b[A-Z]{3,}\\b|\\w+\\(\\)|@\\w+") {
            let nsText = text as NSString
            let matches = re.matches(in: text, options: [],
                                      range: NSRange(location: 0, length: nsText.length))
            if matches.count > 5 { score += 1 }
        }

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

    /// Core extraction: text → passport. FM gated; em iPad Air gen 4 retorna sem summary/domain.
    private func extractPassportCore(path: String, rawContent: String,
                                      domainOptions: [String]) -> (PassportResult?, String?) {
        let truncated = String(rawContent.prefix(8000))

        let concepts = self.extractConcepts(from: truncated)
        let difficulty = self.computeDifficulty(text: truncated)

        var oneLineSummary = ""
        var domain: [String] = []

        #if canImport(FoundationModels)
        if #available(iOS 26.0, macOS 26.0, *) {
            let model = SystemLanguageModel.default
            if case .available = model.availability {
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

                    if let start = clsRaw.firstIndex(of: "["),
                       let end = clsRaw.lastIndex(of: "]"), start < end {
                        let candidate = String(clsRaw[start...end])
                        if let data = candidate.data(using: .utf8),
                           let parsed = try? JSONSerialization.jsonObject(with: data) as? [String] {
                            let allowedLower = Set(domainOptions.map { $0.lowercased() })
                            for cat in parsed {
                                if allowedLower.contains(cat.lowercased()) {
                                    if let canonical = domainOptions.first(where: { $0.lowercased() == cat.lowercased() }) {
                                        if !domain.contains(canonical) {
                                            domain.append(canonical)
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        #endif

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
        if #available(iOS 17.0, macOS 14.0, *) {
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

        let embURL = URL(fileURLWithPath: (embPath as NSString).expandingTildeInPath)
        let pasURL = URL(fileURLWithPath: (pasPath as NSString).expandingTildeInPath)

        guard let embRaw = try? String(contentsOf: embURL, encoding: .utf8) else {
            return Response(status: .badRequest, payload: ["error": "não foi possível ler embeddings em \(embPath)"])
        }
        guard let pasRaw = try? String(contentsOf: pasURL, encoding: .utf8) else {
            return Response(status: .badRequest, payload: ["error": "não foi possível ler passaportes em \(pasPath)"])
        }

        var passportByPath: [String: [String: Any]] = [:]
        for line in pasRaw.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }
            guard let data = trimmed.data(using: .utf8),
                  let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let path = obj["path"] as? String else { continue }
            passportByPath[path] = obj
        }

        guard let queryVec = self.embedQuerySync(query) else {
            return Response(status: .internalServerError, payload: ["error": "embedding indisponível"])
        }

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

        candidates.sort { $0.cosine > $1.cosine }
        let pool = Array(candidates.prefix(topN * 2))

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
                if overlap.isEmpty { continue }
            } else {
                let queryTokens = Set(query.lowercased().split(separator: " ").map(String.init))
                overlap = concepts.filter { queryTokens.contains($0.lowercased()) || conceptsLower.contains($0.lowercased()) && queryTokens.contains($0.lowercased()) }
            }

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

            if let cardData = try? JSONSerialization.data(withJSONObject: card) {
                totalBytes += cardData.count
            }
            if let cc = passport["char_count"] as? Int {
                wouldBeBytes += cc
            }

            if results.count >= topN { break }
        }

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

    // MARK: - /v1/passport/claim & /v1/passport/release — coordenação cross-device via filesystem locks

    /// SHA-256 hex de uma string, para gerar lock filename a partir de note_path.
    private static func sha256Hex(_ s: String) -> String {
        let data = Data(s.utf8)
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    /// Resolve diretório de claims em vault_root/.obsidian/plugins/zeus/data/claims/
    private func claimsDir(vaultRoot: String) -> URL {
        let expanded = (vaultRoot as NSString).expandingTildeInPath
        let base = URL(fileURLWithPath: expanded)
        return base
            .appendingPathComponent(".obsidian")
            .appendingPathComponent("plugins")
            .appendingPathComponent("zeus")
            .appendingPathComponent("data")
            .appendingPathComponent("claims")
    }

    /// Parse ISO-8601 com fração de segundos; retorna nil se falhar.
    private static func parseISO8601(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        let f2 = ISO8601DateFormatter()
        f2.formatOptions = [.withInternetDateTime]
        return f2.date(from: s)
    }

    private static func formatISO8601(_ d: Date) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.string(from: d)
    }

    private func handlePassportClaim(bodyJSON: String) -> Response {
        guard let json = Self.parseJSON(bodyJSON),
              let notePath = json["note_path"] as? String, !notePath.isEmpty,
              let vaultRoot = json["vault_root"] as? String, !vaultRoot.isEmpty,
              let deviceId = json["device_id"] as? String, !deviceId.isEmpty else {
            return Response(status: .badRequest, payload: [
                "error": "body inválido: requer {\"note_path\", \"vault_root\", \"device_id\", \"ttl_seconds\"?}"
            ])
        }
        let ttl = (json["ttl_seconds"] as? Int) ?? 60

        let dir = self.claimsDir(vaultRoot: vaultRoot)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        } catch {
            return Response(status: .internalServerError, payload: [
                "error": "não foi possível criar dir de claims: \(error)"
            ])
        }

        let lockName = Self.sha256Hex(notePath) + ".lock"
        let lockURL = dir.appendingPathComponent(lockName)
        let now = Date()
        let expiresAt = now.addingTimeInterval(TimeInterval(ttl))

        // Verifica lock existente
        if FileManager.default.fileExists(atPath: lockURL.path),
           let existingData = try? Data(contentsOf: lockURL),
           let existing = try? JSONSerialization.jsonObject(with: existingData) as? [String: Any],
           let curHolder = existing["device_id"] as? String,
           let expStr = existing["expires_at"] as? String,
           let expDate = Self.parseISO8601(expStr) {
            // Lock ainda válido?
            if expDate > now {
                if curHolder == deviceId {
                    // Renova
                    let payload: [String: Any] = [
                        "device_id": deviceId,
                        "note_path": notePath,
                        "claimed_at": Self.formatISO8601(now),
                        "expires_at": Self.formatISO8601(expiresAt)
                    ]
                    if !self.writeLockAtomic(lockURL: lockURL, payload: payload) {
                        return Response(status: .internalServerError, payload: ["error": "falha ao escrever lock"])
                    }
                    return Response(status: .ok, payload: [
                        "claimed": true,
                        "current_holder": deviceId,
                        "claimed_at": Self.formatISO8601(now),
                        "expires_at": Self.formatISO8601(expiresAt),
                        "renewed": true
                    ])
                } else {
                    return Response(status: .ok, payload: [
                        "claimed": false,
                        "current_holder": curHolder,
                        "claimed_at": existing["claimed_at"] ?? "",
                        "expires_at": expStr,
                        "renewed": false
                    ])
                }
            }
            // Expirado → sobrescreve abaixo
        }

        let payload: [String: Any] = [
            "device_id": deviceId,
            "note_path": notePath,
            "claimed_at": Self.formatISO8601(now),
            "expires_at": Self.formatISO8601(expiresAt)
        ]
        if !self.writeLockAtomic(lockURL: lockURL, payload: payload) {
            return Response(status: .internalServerError, payload: ["error": "falha ao escrever lock"])
        }
        return Response(status: .ok, payload: [
            "claimed": true,
            "current_holder": deviceId,
            "claimed_at": Self.formatISO8601(now),
            "expires_at": Self.formatISO8601(expiresAt),
            "renewed": false
        ])
    }

    /// Atomic write: escreve em .tmp e renomeia para o destino final.
    private func writeLockAtomic(lockURL: URL, payload: [String: Any]) -> Bool {
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else {
            return false
        }
        let tmpURL = lockURL.deletingLastPathComponent()
            .appendingPathComponent(lockURL.lastPathComponent + ".tmp.\(ProcessInfo.processInfo.processIdentifier).\(UInt32.random(in: 0...UInt32.max))")
        do {
            try data.write(to: tmpURL, options: .atomic)
            if FileManager.default.fileExists(atPath: lockURL.path) {
                _ = try? FileManager.default.removeItem(at: lockURL)
            }
            try FileManager.default.moveItem(at: tmpURL, to: lockURL)
            return true
        } catch {
            _ = try? FileManager.default.removeItem(at: tmpURL)
            return false
        }
    }

    private func handlePassportRelease(bodyJSON: String) -> Response {
        guard let json = Self.parseJSON(bodyJSON),
              let notePath = json["note_path"] as? String, !notePath.isEmpty,
              let vaultRoot = json["vault_root"] as? String, !vaultRoot.isEmpty,
              let deviceId = json["device_id"] as? String, !deviceId.isEmpty else {
            return Response(status: .badRequest, payload: [
                "error": "body inválido: requer {\"note_path\", \"vault_root\", \"device_id\"}"
            ])
        }

        let dir = self.claimsDir(vaultRoot: vaultRoot)
        let lockURL = dir.appendingPathComponent(Self.sha256Hex(notePath) + ".lock")

        guard FileManager.default.fileExists(atPath: lockURL.path) else {
            return Response(status: .ok, payload: [
                "released": true,
                "reason": "no_lock_existed"
            ])
        }

        guard let data = try? Data(contentsOf: lockURL),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let holder = obj["device_id"] as? String else {
            // Lock corrompido — limpa.
            _ = try? FileManager.default.removeItem(at: lockURL)
            return Response(status: .ok, payload: [
                "released": true,
                "reason": "corrupt_lock_removed"
            ])
        }

        if holder != deviceId {
            return Response(status: .ok, payload: [
                "released": false,
                "reason": "lock_held_by_other_device",
                "current_holder": holder
            ])
        }

        do {
            try FileManager.default.removeItem(at: lockURL)
            return Response(status: .ok, payload: [
                "released": true,
                "reason": "released"
            ])
        } catch {
            return Response(status: .internalServerError, payload: [
                "released": false,
                "reason": "remove_failed: \(error)"
            ])
        }
    }

    // MARK: - /v1/afm/refine (v1.3 — Writing Tools nativo via FoundationModels)

    private func handleRefine(bodyJSON: String) -> Response {
        guard let json = Self.parseJSON(bodyJSON),
              let text = json["text"] as? String, !text.isEmpty else {
            return Response(status: .badRequest, payload: [
                "error": "body inválido: requer {\"text\": \"...\", \"mode\": \"proofread|rewrite|simplify\"}"
            ])
        }
        let mode = ((json["mode"] as? String) ?? "proofread").lowercased()
        let tone = (json["tone"] as? String)?.lowercased()
        let language = (json["language"] as? String)?.lowercased()
        let maxTokens = (json["max_tokens"] as? Int) ?? 800

        let languageDirective: String
        switch language {
        case "pt", "pt-br", "portuguese":
            languageDirective = "Responda em português brasileiro."
        case "en", "english":
            languageDirective = "Respond in English."
        default:
            languageDirective = "Mantenha o idioma original do texto."
        }

        let instructions: String
        switch mode {
        case "rewrite":
            let toneDirective: String
            switch tone {
            case "academic":
                toneDirective = "Adote tom acadêmico, vocabulário técnico, estrutura formal."
            case "professional":
                toneDirective = "Adote tom profissional, claro e objetivo."
            case "casual":
                toneDirective = "Adote tom conversacional e acessível."
            default:
                toneDirective = "Preserve o tom do texto original."
            }
            instructions = """
            Você é um editor. Reescreva o texto preservando o sentido.
            \(toneDirective) \(languageDirective)
            Retorne APENAS o texto reescrito, sem explicações.
            """
        case "simplify":
            instructions = """
            Você é um editor que torna textos acessíveis. Reescreva com linguagem clara,
            frases curtas, menos jargão. Preserve sentido técnico essencial.
            \(languageDirective) Retorne APENAS o texto simplificado.
            """
        default: // proofread
            instructions = """
            Você é um revisor. Corrija gramática, ortografia, pontuação.
            NÃO mude estilo, tom ou vocabulário — apenas corrija erros.
            \(languageDirective) Retorne APENAS o texto corrigido.
            """
        }

        return self.runFoundationModel(
            instructions: instructions,
            prompt: text,
            maxTokens: maxTokens,
            extraPayload: [
                "task": "refine",
                "mode": mode,
                "tone": tone ?? "",
                "language": language ?? "auto"
            ]
        )
    }

    // MARK: - /v1/asp/transcribe (v1.3 — dual-engine: SA + SF fallback)

    private func handleASPTranscribe(bodyJSON: String) -> Response {
        guard let json = Self.parseJSON(bodyJSON),
              let path = json["path"] as? String, !path.isEmpty else {
            return Response(status: .badRequest, payload: [
                "error": "body inválido: requer {\"path\": \"/path/to/audio.m4a\"}"
            ])
        }
        let localeID = (json["locale"] as? String) ?? Locale.current.identifier
        let engineRequested = ((json["engine"] as? String) ?? "auto").lowercased()

        let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        guard FileManager.default.fileExists(atPath: url.path) else {
            return Response(status: .badRequest, payload: [
                "error": "arquivo de áudio não encontrado: \(url.path)"
            ])
        }

        #if canImport(Speech) && canImport(AVFoundation)
        let asset = AVURLAsset(url: url)
        let durationSeconds = CMTimeGetSeconds(asset.duration)

        // Engine SA (SpeechAnalyzer iOS 26+/macOS 26+) — tenta primeiro em "auto" ou "sa"
        if #available(iOS 26.0, macOS 26.0, *), engineRequested != "sf" {
            if let saResult = self.transcribeWithSpeechAnalyzer(url: url, localeID: localeID, durationSeconds: durationSeconds) {
                return saResult
            }
            if engineRequested == "sa" {
                return Response(status: .internalServerError, payload: [
                    "error": "SpeechAnalyzer falhou (asset missing ou unsupported locale)"
                ])
            }
            // auto: fallback SF
        }

        // Engine SF (SFSpeechRecognizer) — estável iOS 10+ / macOS 10.15+
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeID)) else {
            return Response(status: .serviceUnavailable, payload: [
                "error": "SFSpeechRecognizer indisponível para locale \(localeID)"
            ])
        }
        guard recognizer.isAvailable else {
            return Response(status: .serviceUnavailable, payload: [
                "error": "SFSpeechRecognizer isAvailable=false para \(localeID)"
            ])
        }

        let request = SFSpeechURLRecognitionRequest(url: url)
        request.shouldReportPartialResults = false
        if recognizer.supportsOnDeviceRecognition {
            request.requiresOnDeviceRecognition = true
        }

        let sem = DispatchSemaphore(value: 0)
        var resultText = ""
        var resultError: String? = nil

        let task = recognizer.recognitionTask(with: request) { (result, error) in
            if let err = error as NSError? {
                if err.domain == "kAFAssistantErrorDomain" && err.code == 1700 {
                    resultText = ""
                } else {
                    resultError = "SFSpeechRecognizer falhou: \(err.localizedDescription) [\(err.domain) \(err.code)]"
                }
                sem.signal()
                return
            }
            guard let result = result else { return }
            if result.isFinal {
                resultText = result.bestTranscription.formattedString
                sem.signal()
            }
        }

        let timeoutSec = max(30.0, min(600.0, durationSeconds * 3 + 30))
        let waitResult = sem.wait(timeout: .now() + .seconds(Int(timeoutSec)))
        if waitResult == .timedOut {
            task.cancel()
            return Response(status: .gatewayTimeout, payload: [
                "error": "SFSpeechRecognizer timeout (\(Int(timeoutSec))s)"
            ])
        }

        if let err = resultError {
            return Response(status: .internalServerError, payload: ["error": err])
        }
        return Response(status: .ok, payload: [
            "text": resultText,
            "duration_seconds": durationSeconds,
            "locale": localeID,
            "on_device": recognizer.supportsOnDeviceRecognition,
            "engine_used": "sf",
            "model": "apple-sfspeechrecognizer",
            "task": "asp_transcribe"
        ])
        #else
        return Response(status: .serviceUnavailable, payload: [
            "error": "Speech / AVFoundation indisponível neste build"
        ])
        #endif
    }

    // Engine SA: SpeechAnalyzer (iOS 26+/macOS 26+) — async paralelo + asset prefetch
    #if canImport(Speech) && canImport(AVFoundation)
    @available(iOS 26.0, macOS 26.0, *)
    private func transcribeWithSpeechAnalyzer(
        url: URL,
        localeID: String,
        durationSeconds: Double
    ) -> Response? {
        let sem = DispatchSemaphore(value: 0)
        var resultText = ""
        var resultError: String? = nil
        var assetInstalled = false

        Task {
            do {
                let locale = Locale(identifier: localeID)
                let bcp47 = locale.identifier(.bcp47)

                guard SpeechTranscriber.isAvailable else {
                    resultError = "SpeechTranscriber.isAvailable=false"
                    sem.signal()
                    return
                }
                let supportedLocales = await SpeechTranscriber.supportedLocales
                guard supportedLocales.contains(where: { $0.identifier(.bcp47) == bcp47 }) else {
                    resultError = "locale \(bcp47) não suportado"
                    sem.signal()
                    return
                }

                let installedLocales = await SpeechTranscriber.installedLocales
                let needsInstall = !installedLocales.contains(where: { $0.identifier(.bcp47) == bcp47 })

                let transcriber = SpeechTranscriber(
                    locale: locale,
                    transcriptionOptions: [],
                    reportingOptions: [],
                    attributeOptions: []
                )
                let modules: [any SpeechModule] = [transcriber]

                if needsInstall {
                    if let request = try await AssetInventory.assetInstallationRequest(supporting: modules) {
                        try await request.downloadAndInstall()
                        assetInstalled = true
                    } else {
                        resultError = "asset não disponível para download (\(bcp47))"
                        sem.signal()
                        return
                    }
                }
                try await AssetInventory.reserve(locale: locale)

                let analyzer = SpeechAnalyzer(modules: modules)
                let (inputStream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
                try await analyzer.start(inputSequence: inputStream)

                let reader = Task<String, Error> {
                    var transcript = ""
                    for try await result in transcriber.results {
                        transcript += String(result.text.characters)
                    }
                    return transcript
                }

                let audioFile = try AVAudioFile(forReading: url)
                let sourceFormat = audioFile.processingFormat
                let targetFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: modules) ?? sourceFormat

                let totalFrames = AVAudioFrameCount(audioFile.length)
                guard let fullInput = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: totalFrames) else {
                    resultError = "falha alocando AVAudioPCMBuffer"
                    sem.signal()
                    return
                }
                try audioFile.read(into: fullInput)

                let bufferToSend: AVAudioPCMBuffer
                if sourceFormat != targetFormat, let converter = AVAudioConverter(from: sourceFormat, to: targetFormat) {
                    let ratio = targetFormat.sampleRate / sourceFormat.sampleRate
                    let outFrames = AVAudioFrameCount(Double(fullInput.frameLength) * ratio) + 4096
                    guard let fullOutput = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: outFrames) else {
                        resultError = "falha alocando output PCM buffer"
                        sem.signal()
                        return
                    }
                    var fed = false
                    var convErr: NSError?
                    converter.convert(to: fullOutput, error: &convErr) { _, statusPtr in
                        if fed { statusPtr.pointee = .endOfStream; return nil }
                        fed = true
                        statusPtr.pointee = .haveData
                        return fullInput
                    }
                    if let convErr = convErr { throw convErr }
                    bufferToSend = fullOutput
                } else {
                    bufferToSend = fullInput
                }

                continuation.yield(AnalyzerInput(buffer: bufferToSend))
                continuation.finish()

                try await analyzer.finalizeAndFinishThroughEndOfInput()
                resultText = try await reader.value
            } catch {
                resultError = "SpeechAnalyzer falhou: \(error)"
            }
            sem.signal()
        }

        let timeoutSec = max(60.0, min(900.0, durationSeconds * 4 + 60))
        let waitResult = sem.wait(timeout: .now() + .seconds(Int(timeoutSec)))
        if waitResult == .timedOut {
            return Response(status: .gatewayTimeout, payload: [
                "error": "SpeechAnalyzer timeout (\(Int(timeoutSec))s — possível asset download em curso)"
            ])
        }
        if resultError != nil {
            FileHandle.standardError.write(Data("[AegisDaemon] SA fallback: \(resultError ?? "")\n".utf8))
            return nil
        }
        return Response(status: .ok, payload: [
            "text": resultText,
            "duration_seconds": durationSeconds,
            "locale": localeID,
            "on_device": true,
            "engine_used": "sa",
            "asset_just_installed": assetInstalled,
            "model": "apple-speechanalyzer-speechtranscriber",
            "task": "asp_transcribe"
        ])
    }
    #endif

    // MARK: - /v1/asp/vad (v1.3 — Voice Activity Detection, pré-filtro)

    private func handleASPVAD(bodyJSON: String) -> Response {
        guard let json = Self.parseJSON(bodyJSON),
              let path = json["path"] as? String, !path.isEmpty else {
            return Response(status: .badRequest, payload: [
                "error": "body inválido: requer {\"path\": \"/path/to/audio.m4a\"}"
            ])
        }
        let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
        guard FileManager.default.fileExists(atPath: url.path) else {
            return Response(status: .badRequest, payload: [
                "error": "arquivo de áudio não encontrado: \(url.path)"
            ])
        }
        #if canImport(AVFoundation)
        do {
            let audioFile = try AVAudioFile(forReading: url)
            let sampleRate = audioFile.processingFormat.sampleRate
            let durationSeconds = Double(audioFile.length) / sampleRate
            let hasSpeech = durationSeconds >= 3.0
            return Response(status: .ok, payload: [
                "has_speech": hasSpeech,
                "duration_seconds": durationSeconds,
                "threshold_seconds": 3.0,
                "model": "duration-heuristic",
                "task": "asp_vad"
            ])
        } catch {
            return Response(status: .badRequest, payload: [
                "error": "não foi possível ler áudio: \(error)"
            ])
        }
        #else
        return Response(status: .serviceUnavailable, payload: ["error": "AVFoundation indisponível"])
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
