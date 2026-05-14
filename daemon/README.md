# Zeus Daemon — Apple-native HTTP servers

Backend Swift do plugin Zeus. **Auto-adapta a cada device do mesh Apple** (Mac mini, MacBook Air, iPad Air, iPhone 15), expondo até 26 endpoints HTTP que cobrem o ecossistema Apple inteiro (FoundationModels + Vision + NaturalLanguage + Translation + CoreSpotlight + Vision Aesthetics/Saliency/FeaturePrint/Barcode/Document).

## Arquitetura por device

```
┌──────────────────────────────────────────────────────────────────────┐
│  PLUGIN OBSIDIAN (TS)                                                 │
│    main.js · lib/*.js · zeus-http-client.js                          │
│                       │                                               │
│                       │ HTTP requestUrl (CORS-bypass oficial)         │
│                       ▼                                               │
│  ┌────────────────────────────────────────────────────────────────┐  │
│  │  DAEMON HTTP — endpoint discovery adaptativo por device         │  │
│  │  ──────────────────────────────────────────────────────────    │  │
│  │                                                                 │  │
│  │  Mac mini M2 Pro / MacBook Air M2 (macOS 26.5)                 │  │
│  │  ZeusDaemonMac standalone executable                            │  │
│  │  bind 127.0.0.1:2223 — LaunchAgent via launchctl                │  │
│  │  → 26 endpoints (FM + Vision + NL + Translation + Spotlight    │  │
│  │     + PIA: passport extract/find + content/get)                 │  │
│  │                                                                 │  │
│  │  iPad Air gen 4 / iPhone 15 (iOS 26.x / iPadOS 26.x)            │  │
│  │  AegisDaemon HTTP layer (embedded em MetassistemaApp-iOS)       │  │
│  │  bind 127.0.0.1:2223 — SwiftNIO ChannelInitializer             │  │
│  │  → 10-22 endpoints (NL + Vision baseline; FM gated por         │  │
│  │     SystemLanguageModel.default.availability)                   │  │
│  └────────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

## Endpoints (canônicos v0.5)

### Camada base (todos os devices Apple-eligible)
- `GET /v1/health` — status + capabilities + endpoint list
- `GET /v1/tools` — list of tools com models e descrições
- `POST /v1/embed` — NLContextualEmbedding 512-dim (anl)

### Camada Foundation Models (Mac always, iOS quando elegível)
- `POST /v1/summarize` — `afm summarize` TL;DR
- `POST /v1/prompt` — `afm prompt` direct generation
- `POST /v1/enrich` — FM com 4 vault tools, suggested_links + connections
- `POST /v1/agent` — react/plan-execute/reflexion patterns
- `POST /v1/classify` — Generable classification
- `POST /v1/graph-extract` — knowledge graph nodes+edges

### Camada Vision (todos os devices, sem ANE-gate)
- `POST /v1/ocr` — VNRecognizeTextRequest (aocr) layout-aware
- `POST /v1/vision/classify` — VNClassifyImageRequest top-N
- `POST /v1/vision/landmarks` — VNDetectFaceLandmarks (face count)
- `POST /v1/vision/saliency` — attention | objectness saliency
- `POST /v1/vision/feature-print` — **VNGenerateImageFeaturePrintRequest 768-dim** (image embedding)
- `POST /v1/vision/aesthetics` — VNCalculateImageAestheticsScoresRequest
- `POST /v1/vision/barcode` — VNDetectBarcodesRequest
- `POST /v1/vision/document` — Vision RecognizeText `.accurate` + bbox per block

### Camada NaturalLanguage (todos os devices)
- `POST /v1/nl/tag` — NLTagger (lemma | nameType | lexicalClass | tokenType)
- `POST /v1/nl/sentiment` — NLTagger .sentimentScore
- `POST /v1/nl/language-detect` — NLLanguageRecognizer top-N

### Camada Translation (macOS 26+, iOS 17.4+)
- `POST /v1/translate` — Apple Translation framework (TranslationSession)

### Camada Data Detection
- `POST /v1/data-detect` — NSDataDetector (URLs, datas, telefones, endereços)

### Camada CoreSpotlight (Mac-only)
- `POST /v1/spotlight/search` — `mdfind` bridge para Spotlight index nativo

### Camada PIA (v0.9 Passport Index Architecture)
- `POST /v1/passport/extract` — combina NLTagger + afm summarize + afm classify + heuristic difficulty em **1 round-trip**
- `POST /v1/passport/batch-extract` — array de paths em sequência
- `POST /v1/passport/find` — cosine vs embeddings.jsonl + concept overlap filter + token savings metrics
- `POST /v1/content/get` — on-demand raw content fetcher (only when agent decides)

## Build + install

### Mac (ZeusDaemonMac executable)
```bash
cd daemon
swift build -c release --product ZeusDaemonMac
./scripts/install-mac-daemon.sh    # LaunchAgent gui/$UID
```

LaunchAgent: `~/Library/LaunchAgents/com.maiocchi.zeusdaemon.plist`  
Logs: `/tmp/zeusdaemon.{out,err}.log`  
Stop: `launchctl bootout gui/$(id -u)/com.maiocchi.zeusdaemon`

### iOS (AegisDaemon HTTP layer dentro do MetassistemaApp-iOS)
```bash
# Open MetassistemaApp.xcworkspace in Xcode 26+
# Plug iPhone/iPad via USB
# Select scheme MetassistemaApp_iOS
# Cmd+R
```

App rodando expõe daemon em loopback `127.0.0.1:2223` (acessível via Tailscale cross-device em `100.65.240.43:2223` iPhone / `100.91.107.120:2223` iPad).

## Adaptive discovery (plugin-side, automático)

O plugin `ZeusHttpClient` probes em ordem:
1. `http://127.0.0.1:2223` (loopback do device atual)
2. `http://100.108.238.49:2223` (Mac mini via Tailscale)
3. `http://100.86.123.88:2223` (MacBook Air via Tailscale)
4. `http://100.91.107.120:2223` (iPad Air via Tailscale)
5. `http://100.65.240.43:2223` (iPhone 15 via Tailscale)

Primeiro que responde `200` em `/v1/health` é usado. Zero-config por device.

## Versões

| Componente | Versão | Date |
|---|---|---|
| ZeusDaemonMac | 0.5.0 | 2026-05-14 |
| AegisDaemon HTTP (iOS) | 0.3.0 | 2026-05-14 |
| Plugin Obsidian | 0.9.0 | 2026-05-14 |

## Estrutura

```
daemon/
├── README.md (este arquivo)
├── Package.swift          ← SwiftPM manifest (targets: ZeusDaemonMac executable + AegisDaemon library)
├── Sources/
│   ├── ZeusDaemonMac/
│   │   ├── main.swift                     ← argument parser, NIO bootstrap, signal handlers
│   │   └── ZeusMacHTTPHandler.swift       ← all 26 endpoints (~2275 LOC)
│   └── AegisDaemon/
│       ├── AegisHTTPServer.swift          ← SwiftNIO ServerBootstrap on port 2223 iOS
│       └── AegisHTTPHandlers.swift        ← 22 iOS endpoints (~1517 LOC)
└── scripts/
    ├── install-mac-daemon.sh              ← swift build + launchctl bootstrap
    └── com.maiocchi.zeusdaemon.plist      ← LaunchAgent manifest
```
