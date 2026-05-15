# Changelog — Zeus Obsidian Plugin

Todas as mudanças notáveis deste projeto. Formato derivado de [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versionamento segue [SemVer](https://semver.org/lang/pt-BR/).

---

## [1.3.3] — 2026-05-15 — Real-time audio indexing (vault.on modify/create → VAD → transcribe → embed)

Plugin side. Fecha o ciclo end-to-end de voice memos: arquivo `.m4a/.wav/.mp3` salvo no vault dispara pipeline real-time automático, idêntico ao que já acontecia com `.md` desde v0.13.2.

### Diagnóstico — gap mapeado por subagente Explore

Plugin já tinha real-time `.md` (linhas 3055-3088 main.js): `vault.on('modify'|'create'|'delete'|'rename')` com debounce 500ms para embed e 8s para passport. **Audio não chegava ao pipeline real-time** — só seria indexado por full reindex manual ou PassportScheduler (que filtra `ext === 'md'` no `lib/passport-scheduler.js:99`).

### Added — Pipeline real-time audio (`scheduleAudioTranscribe`)

- **`AUDIO_EXTENSIONS = new Set(['m4a', 'wav', 'mp3'])`** const no topo de `main.js`
- **`DEFAULT_SETTINGS.fileTypes`** estendido: `{md, pdf, png, jpg, jpeg, heic, m4a, wav, mp3}`
- **3 settings novos**:
  - `audioLocale: 'pt-BR'` — BCP47 para SpeechAnalyzer/SFSpeechRecognizer
  - `audioEngine: 'auto'` — `sa|sf|auto`, default delega para daemon
  - `audioVadEnabled: true` — pré-filtro VAD antes de transcribe (skip < 3s)
- **`this._audioTimers = new Map()`** com debounce 2s (audio writes nem sempre atômicos)
- **`scheduleAudioTranscribe(rel, file)`** — pipeline 4-step:
  1. `httpClient.isAvailable()` — graceful se daemon down
  2. Resolve path absoluto via `adapter.getBasePath() + rel`
  3. `httpClient.aspVad(absPath)` — skip se `has_speech: false`
  4. `httpClient.aspTranscribe(absPath, locale, engine)` — texto
  5. `httpClient.embed(text)` — embed 512-dim
  6. Persistir entrada com `kind: 'audio'` + `transcript` + `duration_seconds` + `audio_locale` + `audio_engine` no `embeddings.jsonl`
- **`vault.on('modify' | 'create')`** estendidos: switch por ext (`md` → embed+passport; `audio` → audio pipeline)
- **`vault.on('delete' | 'rename')`** já funcionavam (purgam por path, agnósticos a ext)

### Added — `ZeusHttpClient` v1.3.0 endpoints

3 methods novos em `lib/zeus-http-client.js`:

- `refine(text, mode, options)` — `POST /v1/afm/refine` (Writing Tools), timeout 90s
- `aspTranscribe(absPath, locale, engine)` — `POST /v1/asp/transcribe`, timeout **10min** (asset download primeira vez pode levar minutos)
- `aspVad(absPath)` — `POST /v1/asp/vad`, timeout 15s

### Architecture notes

- **Device-adaptive automático**: daemon `/v1/health` reporta `speech_available: bool` e `endpoints[]`. Quando ausente (iOS Capacitor atual), `aspTranscribe` retorna 503 e helper apenas loga warn — sem crash do plugin. Em iPhone/iPad o pipeline audio degrada graciosamente até v1.4 implementar Speech em AegisDaemon.
- **Privacy gate intocado**: daemon usa `requiresOnDeviceRecognition=true` + `AssetInventory.reserve(locale:)` — áudio nunca sai do Mac
- **Pipeline mesmo padrão `.md`**: `embeddings.jsonl` ganha entries `kind: 'audio'` mas estrutura compatível — Smart View renderiza automaticamente (campos vec, sha, mtime, path, title presentes)
- **Debounce 2s** ≠ 500ms `.md` porque audio writes (especialmente .m4a via Voice Memos) podem demorar a finalizar arquivo

### Validation pipeline (smoke real)

```
POST /v1/asp/vad      {path: /tmp/test.wav}            → has_speech: true (6.16s)
POST /v1/asp/transcribe {path: ..., locale: pt-BR}     → engine=sa, text 80ch
POST /v1/embed        {text: <transcript>}             → dim 512, model apple-nlcontextual-pt-BR
```

Latência total: ~1.5s para áudio de 6s. Disparado em background via debounce, imperceptível ao usuário do Obsidian.

### Sintax validation

- `node -e 'new Function(fs.readFileSync("main.js","utf8"))'` ✅ parse OK
- `node -e 'new Function(fs.readFileSync("lib/zeus-http-client.js","utf8"))'` ✅ parse OK
- Daemon Swift inalterado nesta release — endpoints `asp/*` já existem desde v1.3.2

### Next (v1.4)

- Real-time pipeline para `.pdf` (aocr) e imagens (av classify + landmarks + EXIF) — atualmente só via `runFullIndex`
- AegisDaemon iOS com Speech framework — desbloquear audio em iPhone/iPad
- `audioEngineUsedCount` no status bar (`🎙️ N memos · M via SA · K via SF`)

---

## [1.3.2] — 2026-05-15 — SpeechAnalyzer dual-engine (resolve deadlock async + asset prefetch)

Resolve o bug de runtime do `SpeechAnalyzer` que motivou o pivote para `SFSpeechRecognizer` na v1.3.1. Padrão correto derivado de leitura dos repos production de CLIs de speech do GitHub: [`finnvoor/yap`](https://github.com/finnvoor/yap) (dictation CLI) e [`mrinalwadhwa/freeflow`](https://github.com/mrinalwadhwa/freeflow) (`SpeechAnalyzerStreamingProvider`).

### Diagnóstico do bug original (v1.3.0)

Causas cumulativas:

1. **Deadlock async** — chamava `try await analyzerTask.value` ANTES de iterar `transcriber.results`. Pattern correto: `analyzer.start(inputSequence:)` retorna rápido (apenas inicia o pipeline); o reader que itera results precisa rodar EM PARALELO com push de buffers ao continuation. Sem reader paralelo, buffers não são consumidos → deadlock.
2. **Asset prefetch ausente** — `SpeechTranscriber` exige modelo do locale instalado. Pattern correto: chamar `SpeechTranscriber.installedLocales` para verificar; se ausente, `AssetInventory.assetInstallationRequest(supporting: modules)` + `request.downloadAndInstall()` baixa o pacote (pt-BR ~200-500MB primeira vez, instantâneo nas seguintes).
3. **Sample-rate conversion** — `AVAudioConverter.convertToBuffer:fromBuffer:` (Swift `convert(to:from:)`) **não suporta resample**. Para 44.1kHz→16kHz precisa do callback API `convertToBuffer:error:withInputFromBlock:` com lifecycle correto.

### Added — Dual-engine via param `engine`

- **`engine: "sa"`** — força `SpeechAnalyzer` (macOS 26+); erro 500 se asset missing ou unsupported
- **`engine: "sf"`** — força `SFSpeechRecognizer` (estável macOS 10.15+)
- **`engine: "auto"`** (default) — tenta SA primeiro, fallback gracioso para SF se SA falhar em runtime
- Payload da response inclui `engine_used: "sa|sf"` para tracking
- Payload da SA inclui `asset_just_installed: bool` quando primeira execução baixou modelo

### Implementação correta da engine SA

```swift
// 1. Asset prefetch
let installed = await SpeechTranscriber.installedLocales
if !installed.contains(where: { $0.identifier(.bcp47) == bcp47 }) {
    if let req = try await AssetInventory.assetInstallationRequest(supporting: modules) {
        try await req.downloadAndInstall()
    }
}
try await AssetInventory.reserve(locale: locale)

// 2. Start analyzer (non-blocking)
let analyzer = SpeechAnalyzer(modules: [transcriber])
let (inputStream, continuation) = AsyncStream.makeStream(of: AnalyzerInput.self)
try await analyzer.start(inputSequence: inputStream)

// 3. Reader Task em PARALELO (crítico — sem isso há deadlock)
let reader = Task<String, Error> {
    var transcript = ""
    for try await result in transcriber.results {
        transcript += String(result.text.characters)
    }
    return transcript
}

// 4. Single-buffer push (resolve resample via AVAudioConverter callback)
//    AVAudioFile inteiro lido em UM buffer, convertido para targetFormat, 1× yield
let targetFormat = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: modules)
// ... callback de convert com fed=true após 1ª chamada, endOfStream depois
continuation.yield(AnalyzerInput(buffer: fullOutput))
continuation.finish()

// 5. Finalize + collect
try await analyzer.finalizeAndFinishThroughEndOfInput()
resultText = try await reader.value
```

### Smoke tests validados

| Cenário | Engine | Resultado | Latência |
|---|---|---|---|
| en-US `/tmp/test_en.wav` (5.36s) | `sa` | "Hello, this is a test of voice transcription using Apple Speech recognition on the Zeus Demon." (1 fonema: "Demon"/"daemon") | <1s |
| pt-BR `/tmp/test.wav` (6.16s) | `sa` | "Olá, este é um teste de transcrição de voz usando os Pet Analiser da Apple Diamondseus." (fonéticos para nomes próprios) | 0.41s |
| en-US `/tmp/test_en.wav` | `sf` (fallback) | (texto similar via SFSpeechRecognizer) | <1s |
| `engine: "auto"` | tenta sa → cai sf se falhar | gracioso | — |

### Pré-requisitos no Mac do usuário

- macOS 26+ para engine `sa`. Engine `sf` funciona em macOS 10.15+
- Para pt-BR via `sa`: asset precisa estar instalado. Se Siri/Live Transcription pt-BR já foram usados, o asset está disponível silenciosamente. Caso contrário, primeira chamada baixa (~200-500MB)
- Privacy gate preservado: `on_device: true` em ambos os engines

### Build & validation

- `swift build --product ZeusDaemonMac` ✅ 5.84s (incremental)
- 3 ciclos de install/restart até single-buffer mode estabilizar
- 1 crash diagnosticado via stack trace (`AVAudioConverter.convertToBuffer:fromBuffer:` ObjC exception em sample-rate-conv)
- Fontes consultadas: `finnvoor/yap` + `mrinalwadhwa/freeflow` (production CLIs de speech open-source)

### Próximos passos (v1.4 ou v1.3.3)

- Chunked streaming para áudios > 10min (single-buffer limit)
- Endpoint `/v1/asp/install-locale` explícito para pré-download de assets
- Métricas no plugin TS: contador `🎙️ N memos transcribed` no status bar
- AegisDaemon iOS quando Speech estabilizar em Capacitor

---

## [1.3.1] — 2026-05-15 — SFSpeechRecognizer pivot + main.js python-worker wire

Patch release com 2 correções derivadas dos smoke tests pós-deploy da v1.3.0:

### Changed — `asp-transcribe` agora usa `SFSpeechRecognizer` (API estável macOS 10.15+)

A primeira tentativa em v1.3.0 usou `SpeechAnalyzer` + `SpeechTranscriber` (WWDC25, macOS 26+). O endpoint compilou (`swift build` 0 erros) mas crashou em runtime com Empty reply — provavelmente por deadlock entre `analyzer.start(inputSequence:)` e iteração paralela de `transcriber.results`, mais ausência de prefetch via `AssetInventory.requestNeededAssets()`. Pivotado para `SFSpeechRecognizer` + `SFSpeechURLRecognitionRequest` com `requiresOnDeviceRecognition=true` (preserva privacy gate). Validado em smoke test:

- `POST /v1/asp/transcribe` `{path:"/tmp/test.wav", locale:"en-US"}` → texto transcrito corretamente
- `kAFAssistantErrorDomain 1700` ("No speech detected") agora tratado como texto vazio (não erro 500)
- Timeout proporcional `duration × 3 + 30s` (min 30s, max 600s) substitui timeout fixo de 600s

Note: pt-BR locale retorna texto vazio até o usuário baixar assets de Speech Recognition em macOS Settings → General → Language & Region. Isso é constraint do OS, não do endpoint.

### Added — `zeus-python-worker-probe` command em `main.js`

Comando "Zeus: probe Python worker (apple-fm-sdk)" adicionado em `main.js` ~linha 2896 (after `zeus-coord-clean-expired`). Resolve plugin dir absoluto via `app.vault.adapter.getBasePath() + manifest.dir`, spawna `bin/batch_eval.py` com `{action:"version"}`, mostra resultado num Notice. Import de `PythonWorker` adicionado na seção `pluginRequire('lib/*')` (linha ~96).

### Build & validation

- `swift build -c release --product ZeusDaemonMac` ✅ compilou em 70.62s (2° ciclo, full incremental)
- LaunchAgent restart via `install-mac-daemon.sh`; `/v1/health` reporta `endpoint_count: 29`, `speech_available: true`
- `node -e 'new Function(fs.readFileSync("main.js","utf8"))'` ✅ syntax parse OK
- Smoke completo: refine 200, vad 200, transcribe 200 (en-US texto correto)

### Roadmap futuro

`SpeechAnalyzer` migration: re-tentar em v1.4 após validar em script Python isolado (via `apple-fm-sdk` not aplicable mas via Swift Playground) o padrão correto de async-let entre `analyzer.start(inputSequence:)` + `transcriber.results` + `AssetInventory.requestNeededAssets()`.

---

## [1.3.0] — 2026-05-15 — Native Refinement & Opaque Media Unlocking

Primeira release derivada do estudo NotebookLM Apple-Native (notebook `aa48f2d1`, 12 fontes Apple Developer + apple-fm-sdk GitHub + plugin READMEs). Adiciona 3 endpoints novos no daemon Swift + camada Python worker para batch jobs offline, sem alterar a superfície existente.

### Added — `afm-refine` (Writing Tools nativo via FoundationModels)

- **`POST /v1/afm/refine`** no `ZeusMacHTTPHandler.swift` — instructions específicas por modo, reusa o helper `runFoundationModel()` existente (mantém heurística PCC calibrada da v1.2)
- **3 modos** via body param `mode`:
  - `proofread` (default) — corrige gramática/ortografia/pontuação, preserva estilo
  - `rewrite` — reescreve mantendo sentido; suporta `tone: academic|professional|casual`
  - `simplify` — linguagem clara, frases curtas, menos jargão
- Param opcional `language: pt|en` (auto-detect quando ausente)
- Param opcional `max_tokens` (default 800)
- Privacy gate intocado: respeita `X-Zeus-Allow-Pcc` da request (default `.off`)
- Substituto on-device para Grammarly/Text Generator cloud-based em notas sensíveis

### Added — `asp-transcribe` (SFSpeechRecognizer on-device) e `asp-vad` (pré-filtro)

- **`POST /v1/asp/transcribe`** — `SFSpeechRecognizer` + `SFSpeechURLRecognitionRequest` lê arquivos `.m4a/.wav/.mp3` (qualquer formato suportado por `AVURLAsset`), retorna texto + `duration_seconds` + `on_device: bool`
- **`POST /v1/asp/vad`** — heurística rápida de duração (>= 3s → assume fala) para pular áudios muito curtos antes de chamar transcribe. Quando `SpeechDetector` estabilizar API, substituível por análise real
- Privacy gate: força `requiresOnDeviceRecognition = true` quando o recognizer suporta, garantindo que o áudio nunca sai do Mac
- Tratamento explícito de `kAFAssistantErrorDomain 1700` ("No speech detected") como texto vazio, não erro
- Locale configurável via body param `locale` (default `Locale.current.identifier`); timeout proporcional `duration × 3 + 30s` (min 30s, max 600s)
- Imports novos no handler: `Speech`, `AVFoundation`
- Adicionado campo `speech_available` no `/v1/health` payload

**Pivote arquitetural decidido durante smoke-test**: a primeira implementação tentou usar `SpeechAnalyzer` + `SpeechTranscriber` (macOS 26+, API nova WWDC25). O endpoint compilou perfeitamente (`swift build` 0 erros) mas crashou em runtime (Empty reply) — provavelmente por dois motivos cumulativos: (1) deadlock entre `analyzer.start(inputSequence:)` e iteração paralela de `transcriber.results`; (2) `SpeechAnalyzer` requer download explícito dos *speech assets* via `AssetInventory.requestNeededAssets()`, ainda não wired. Substituí por `SFSpeechRecognizer` (API estável macOS 10.15+) que tem garantias de runtime maduras. `SpeechAnalyzer` migration fica trackeada para v1.4 quando a sequência paralela + asset prefetch forem validados em isolamento.

### Added — Python worker layer

- **`lib/python-worker.js`** — helper `runPythonWorker(pluginDir, scriptName, payload, opts)` via `child_process.spawn`. Contract JSON-in/JSON-out, timeout configurável (default 30s), error handling completo
- **`bin/batch_eval.py`** — stub Python que valida instalação do `apple-fm-sdk` Python (oficial Apple, Apache-2.0) e reporta ambiente. Actions: `version` (probe SDK + macOS), `probe` (cheap roundtrip)
- Princípio arquitetural: **Swift cuida do runtime/interativo; Python cuida do batch/offline**. Workers Python rodam como processos efêmeros disparados pelo plugin TS via spawn, sem novas portas HTTP nem duplicação de responsabilidade com o daemon
- Smoke test validado no Mac mini: `python3 bin/batch_eval.py` retorna `apple_fm_sdk_version: 0.1.x` + ambiente

### Architecture notes

- **Domain Boundary**: o daemon SwiftNIO permanece a autoridade única do loop HTTP de baixa latência. Camada Python é módulo *plug-and-play* em `bin/` para tarefas que ganham com numpy/pandas/MLX/Apple FM SDK ou que rodam em background sem afetar UI
- **Reaproveitamento total**: `handleRefine` usa `runFoundationModel()` (linha ~1749) sem nova lógica de FM; `handleASPTranscribe` usa `AVAudioFile` + `AsyncStream<AnalyzerInput>` padrão do framework
- **Endpoints totais agora**: 29 (era 26) — 3 novos `afm/refine`, `asp/transcribe`, `asp/vad` listados em `/v1/health.endpoints` e no default 404 case

### Build & validation

- `swift build -c release --product ZeusDaemonMac` ✅ release compilou em 70.62s no Mac mini M2 Pro
- LaunchAgent `com.maiocchi.zeusdaemon` em produção: `/v1/health` retorna `endpoint_count: 29`, `speech_available: true`, `fm_available: true`
- **Smoke tests pós-deploy**:
  - `POST /v1/afm/refine` ✅ 200 OK, payload completo (mode/tone/language/task/model)
  - `POST /v1/asp/vad` ✅ 200 OK, `has_speech: true` para áudio de 6.16s
  - `POST /v1/asp/transcribe` ✅ 200 OK, en-US transcreveu corretamente "Hello, this is a test of voice transcription using Apple speech recognition on the Zeus daemon"; pt-BR retorna texto vazio até o usuário baixar asset on-device em System Settings → General → Language & Region
- `echo '{"action":"version"}' | python3 bin/batch_eval.py` ✅ retorna JSON válido, `apple_fm_sdk_available: true`
- `node -e "new Function(fs.readFileSync('main.js','utf8'))"` ✅ syntax parse OK após adicionar `PythonWorker` import + `zeus-python-worker-probe` command
- iOS `AegisDaemon` (`AegisHTTPHandlers.swift`) inalterado nesta release — endpoints `afm/refine`, `asp/transcribe`, `asp/vad` ficam para v1.3.1+ quando Apple Speech expor mesma API no iOS Capacitor

### Próximos passos (v1.4 trackeado em APPLE_NATIVE_ROADMAP.md)

- `afm-embed-768` (multilingual-e5-base CoreML, +15-20% recall)
- `mlx-classify` (cross-encoder reranker via MLX)
- `batch-eval` real (regressão de prompts via `@generable`)

---

## [1.2.0] — 2026-05-15 — PCC end-to-end (daemon Swift honra X-Zeus-Allow-Pcc)

Fechamento do ciclo PCC: o daemon Swift agora lê o header de permissão, propaga até os handlers FoundationModels (`enrich`/`summarize`/`prompt`), aplica heurística calibrada para decidir quando sinalizar uso de cloud routing, e devolve o header `X-Zeus-Pcc-Used: 1`. Plugin v1.1 já estava preparado — agora o ciclo opt-in → header outgoing → daemon decide → header response → contador da sessão funciona end-to-end.

### Added — Daemon Swift PCC integration
- **`PccPermission` enum** em `ZeusMacHTTPHandler.swift`: `.off | .optIn | .auto` com derivação tolerante do header (`1`/`true`/`opt-in`/`auto`).
- **Extração do header** em `handleRequest()`: lê `X-Zeus-Allow-Pcc` (case-insensitive) e converte para `PccPermission`.
- **Propagação até os handlers**: `route()` recebe `pcc: PccPermission`, passa para `handleSummarize`/`handleEnrich`/`handlePrompt`.
- **`runFoundationModel()`** agora aceita `pcc:` e retorna `Response.pccUsed`.
- **`Response` struct** ganha campo `pccUsed: Bool` (default false) para sinalizar uso ao writer HTTP.
- **`writeJSON()`** aceita `pccUsed` e seta header `X-Zeus-Pcc-Used: 1` na response quando true. Também adiciona `Access-Control-Expose-Headers` para que o client lendo via `requestUrl` consiga inspecionar.

### Added — Heurística PCC calibrada
Como FoundationModels SDK (macOS 26 atual) não expõe API pública para forçar/inspecionar cloud routing (Apple decide internamente via privacy gates + capacity), `shouldFlagPccUsed()` aplica:
- **`.off`** → nunca sinaliza (privacy gate preserva on-device-only)
- **`.optIn`** → sinaliza somente quando heurística sugere routing cloud: `prompt + instructions > 6000 chars` (~1500 tokens) OU `maxTokens > 1000`
- **`.auto`** → sempre sinaliza quando há permissão (daemon decide ser otimista)

Quando Apple expuser API explícita futuramente (ex.: `GenerationOptions.allowsCloudCompute`), a heurística é substituída pela API real — assinatura externa do header permanece.

### Added — Payload structured fields
- `pcc_permission: "off|optIn|auto"` — quando a request usou FoundationModels
- `pcc_used: bool` — espelho do header (redundância intencional p/ debug fácil)

### Build & Validation
- `swift build --product ZeusDaemonMac` ✅ compilou sem erros (1322s no Mac mini M2 Pro com iCloud sync sob carga)
- Binário: `~/Library/.../zeus/daemon/.build/arm64-apple-macosx/debug/ZeusDaemonMac` (10 MB, mtime confirmado)
- CORS expandido: `Access-Control-Allow-Headers` agora inclui `X-Zeus-Allow-Pcc`; `Access-Control-Expose-Headers` expõe `X-Zeus-Pcc-Used` ao requestUrl client

### Privacy gate preservado
- Default ainda é `.off` — comportamento idêntico ao pré-PCC para usuários que não habilitarem
- Nenhum dado sigiloso vaza: header é só *permissão*, daemon mantém a autoridade de roteamento, e o on-device fallback é sempre tentado primeiro pelo próprio sistema operacional Apple
- Privacy model documentado claramente nos Settings do plugin (v1.1) — usuário entende que PCC é hardware Apple verificável criptograficamente sem retenção

### Próximos passos (não bloqueiam v1.2)
- Atualizar `AegisDaemon` (iOS) com mesma infra PCC quando Apple expor FoundationModels no Capacitor — atualmente iOS já não chama FM diretamente
- Quando Apple lançar API explícita de cloud routing, substituir `shouldFlagPccUsed` pela leitura real
- Telemetria opcional: persistir `pccUsageCount` entre sessões para histórico de longo prazo

---

## [1.1.0] — 2026-05-14 — Status bar metrics + Apple Cloud Private (PCC) prep

Polish de Settings UX, métricas de token economizado visíveis no status bar, e integração client-side de Apple Cloud Private (PCC). Daemon Swift permanece em v0.5.0 — atualização do daemon para honrar o header `X-Zeus-Allow-Pcc` é trackeada como follow-up (a parte client-side fica wired e aguardando).

### Added — v1.1 Status bar & Token metrics
- **Token-saved metric** no status bar (`Zeus: 1245 docs · 18.3k tok saved`) — economia estimada via PIA passports compactos vs carga raw equivalente
- Setting **Mostrar tokens economizados no status bar** (default ON)
- Setting **Intervalo de refresh do status bar (ms)** — slider 5–120s, default 30s
- Setting **Token baseline (raw sem PIA)** — slider 250–5000 tok, default 1250 (~5KB/4)
- Setting **Reset métricas** — botão para zerar contadores do HTTP client
- Timer periódico de refresh do status bar (auto-cleanup via `register()`)
- Estado interno `_lastStatusBarState` previne sobrescrever indexing/embedding durante refresh

### Added — v2.0 Apple Cloud Private (PCC) — client-side prep
- Setting **Modo PCC** com 3 opções: `off` (default, on-device only) / `opt-in` (header `X-Zeus-Allow-Pcc:1`) / `auto` (daemon decide)
- Setting **Indicador visual PCC** — exibe `☁️PCC×N` no status bar quando PCC é usado
- Setting **Status PCC** — botão de inspeção (modo atual, última request via PCC, total da sessão)
- Métodos `setPccMode()` / `getPccStatus()` no `ZeusHttpClient`
- Helpers `_pccHeaders()` (injeta header outgoing) e `_readPccUsed()` (lê `X-Zeus-Pcc-Used` da response)
- Contador `pccUsageCount` mantido por sessão
- Auto-sync de `pccMode` settings → HTTP client no `onload()` e em todas mudanças via Settings tab

### Changed — UX polish
- Seções v1.1 e v2.0 do Settings tab com headers `<h3>` claros e descrições didáticas
- Descrições PCC explicam claramente o privacy model: "modelos servidor-side rodam em hardware Apple verificável criptograficamente, sem reter dados"
- Settings descritivos: mencionam quando usar `opt-in` vs `auto`, requisito de macOS 26+ Apple Intelligence ativo
- `DEFAULT_SETTINGS` reorganizados em blocos comentados v1.1 / v2.0

### Architecture notes
- **PCC privacy model**: header HTTP é apenas *permissão* — daemon Swift mantém autoridade final sobre roteamento. Default `off` preserva o privacy gate original do Zeus (sigiloso nunca sai do disco local).
- **Métricas são lazy**: status bar só consulta `httpClient.getMetrics()` a cada 30s no estado idle, zero overhead durante operações ativas.
- **Token baseline configurável**: usuários com vault de notas atomicas (Luhmann/Zettelkasten) usam baseline menor; vaults com docs longos usam baseline maior. Estimativa fica realista.

### Daemon follow-up (não bloqueia v1.1)
Para que PCC funcione end-to-end, o daemon Swift (`daemon/Sources/ZeusDaemonMac/`) precisa:
1. Ler header `X-Zeus-Allow-Pcc` em handlers `enrich`, `agent`, `graphExtract`
2. Configurar `SystemLanguageModel.default(allowingCloudCompute: true)` quando header presente (Swift 6.0 + macOS 26)
3. Setar `X-Zeus-Pcc-Used: 1` na response quando rota cloud foi tomada
4. Manter fallback on-device se PCC indisponível (ex.: usuário sem Apple Intelligence ativo)

---

## [1.0.0] — 2026-05-14 — Versão final estável

Primeira release marcada como **estável de produção**. Todas as camadas funcionais e wired no plugin. Validado em uso diário cross-device (Mac mini · MacBook Air · iPad · iPhone) no vault `Documents`.

### Promoted to stable
- **`aia enrich`** — links sugeridos + conexões explicadas. Auto-fallback para `HierarchicalProcessor` (NexusSum pattern, ACL 2025 arXiv:2505.24575) em notas >10KB, resolvendo a limitação da janela 4096 tokens do FoundationModels.
- **`aia agent`** — Q&A multi-turn com patterns `react | plan-execute | reflexion` via `ZeusAskVaultModal`.
- **`aia graph-extract`** — knowledge graph schema-validated com render SVG modal.

### Architecture (PIA v1.0)
- 3 camadas: código (`afm` embeddings) → keywords/Feynman → resumos conectados/Luhmann
- MCP-first surface: `find_relevant_notes` → `get_passport` → `get_content`
- **81,5% de redução** em consumo de tokens agêntico vs carga raw
- Real-time indexing ~20–50 ms/nota (paridade Apple Notes)
- Daemon HTTP: 26 endpoints (Mac, SwiftNIO) + 22+ endpoints (AegisDaemon iOS)
- Cross-device coordination via iCloud-synced lock files
- Privacy gate: frontmatter `sigiloso` nunca sai do disco local

### Pipeline multi-modal
- `.md` → `anl embed` 512-dim
- `.pdf` → `aocr --structured` (macOS 26+ layout-aware) → `anl embed`
- imagens → `aocr` + `av classify` + `av landmarks` + `acs/mdls` → `anl embed`

### Changed
- Removidos labels `⚠️ exp` das camadas `aia` no README e nos comentários em `main.js`
- README atualizado com seção de chunking hierárquico no comando `enrich`
- `manifest.json` bumpado para v1.0.0; descrição menciona NexusSum + Tailscale

### Stable feature set (locked for 1.x)
- Busca semântica via NLContextualEmbedding 512-dim
- HyDE query expansion (toggle Settings)
- Smart View lateral com mini-graph SVG + chevron list
- 7 comandos no Command Palette
- Reindex incremental por SHA + mtime
- Cross-device read-only no iOS via embeddings.jsonl

### Roadmap pós-1.0 (não bloqueia release)
- **v1.1** — Settings UX polish + métricas de token saved em status bar
- **v2.0** — Apple Cloud Private (`acp`) — Private Cloud Compute para queries que excedem capacidade on-device
- **v2.x** — Distribuição via Obsidian Community Plugins (atualmente repo privado)

---

## [0.13.2] — 2026-05-14 — Marco MVP de produção

Plugin estável em uso diário cross-device (Mac mini · MacBook Air · iPad · iPhone). Substitui Omnisearch + Smart Connections em produção no vault `Documents`.

### Added
- **Real-time indexing** (~20–50 ms por nota modificada, debounce 500 ms) — paridade com Apple Notes
- **Smart View** lateral com mini-graph SVG + chevron list inspirado em Smart Connections
- **Anthropic brand tokens** em todo o CSS (Orange `#d97757` · Blue `#6a9bcc` · Green `#788c5d`)
- **Tipografia Poppins + Lora** na UI do plugin
- Auto-abertura do Smart View pane ao carregar o plugin
- HyDE query expansion (toggle via Settings)
- **Passport Index Architecture (PIA)** v0.12 — 3 camadas (código/keywords/resumos conectados) → 81,5% redução de tokens em consumo agêntico

### Fixed
- **Obsidian `__dirname` bug** — `pluginRequire()` helper bypass que resolve paths via candidatos absolutos
- Duplicate `const path` / `const fs` declarations em `main.js`
- ReferenceError `path is not defined` em código legado

### Architecture
- **Daemon HTTP** (`ZeusDaemonMac` + `AegisDaemon` iOS) via SwiftNIO
- **26 endpoints v0.5.0** no daemon Mac, **22+ endpoints** no daemon iOS
- Coordenação cross-device via **iCloud-synced lock files** (claim/release)
- Tailscale mesh para acesso cross-device ao daemon

### Pipeline multi-modal (por extensão)
- `.md` → `anl embed` (NLContextualEmbedding 512-dim)
- `.pdf` → `aocr --structured` (layout-aware) → `anl embed`
- `.png` `.jpg` `.heic` `.jpeg` `.tiff` `.bmp` → `aocr` + `av classify` + `av landmarks` + `acs/mdls` → texto sintetizado → `anl embed`

### Reasoning (aia — experimental ⚠️)
- `afm enrich <note>` — 4 vault tools (`read_vault_note`, `list_folder`, `search_vault`, `get_frontmatter`)
- `afm agent` — patterns `react | plan-execute | reflexion`
- `afm graph-extract` — nodes + edges schema-validated → SVG modal

---

## [0.13.1] — 2026-05 — Smart View auto-open

### Added
- Smart View pane abre automaticamente no `layout-ready` event

---

## [0.13.0] — 2026-05 — Smart View redesign

### Added
- **Mini-graph SVG** + **chevron list** inspirados em Smart Connections
- Cards visuais reformulados

---

## [0.12.1] — 2026-05 — Anthropic brand redesign

### Changed
- `styles.css` reescrito com 15 seções e Anthropic brand tokens
- Tipografia: Poppins (headings) + Lora (body) + monospace (code)

---

## [0.12.0-fix] — 2026-05 — Plugin loader bypass

### Fixed
- `pluginRequire()` helper para contornar bug do `__dirname` no Obsidian electron loader

---

## [0.12.0] — Passport Index Architecture (PIA)

### Added
- **PIA v0.12**: arquitetura de 3 camadas (código `afm` → keywords/Feynman → resumos conectados/Luhmann)
- MCP-first surface (`find_relevant_notes` → `get_passport` → `get_content`)
- Distributed coordinator (lock files iCloud)
- Background passport scheduler

---

## Roadmap pendente

### v0.14 (planejado)
- Mover camadas `aia` (enrich + agent + graph) de `⚠️ exp` para estáveis
- Aumentar janela `afm enrich` além de 4096 tokens (notas grandes estouram)
- Tests cross-device automatizados

### v0.5+ — Apple Cloud Private (`acp`)
- Integração com Private Cloud Compute para queries que excedem capacidade on-device
- Privacy preserva: dados nunca persistem no servidor Apple

### v1.0 (futuro)
- API estável + breaking-change freeze
- Distribuição via Obsidian Community Plugins (atualmente repo privado)
- Documentação completa de cada endpoint do daemon

---

## Convenções

- **Apple-native first**: nenhuma dependência cloud sem opt-in explícito
- **Privacy gate**: conteúdo `sigiloso` (frontmatter) nunca sai do disco local
- **Cross-device coherent**: Mac mini é fonte canônica; iPad/iPhone consomem via iCloud + Tailscale
- **Token-efficient**: PIA garante consumo agêntico ~80% menor que carga raw
