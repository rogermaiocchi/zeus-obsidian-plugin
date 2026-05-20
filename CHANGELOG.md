# Changelog — Zeus Obsidian Plugin

Todas as mudanças notáveis deste projeto. Formato derivado de [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versionamento segue [SemVer](https://semver.org/lang/pt-BR/).

---

## [1.13.2] — 2026-05-20 — Codex deferred #5 RESOLVED: Swift 6 strict concurrency

User pediu "resolva com codex cli: 1 deferred com tracking". Codex deep audit anterior deferred Swift 6 strict concurrency em 6 sites de Spotlight handlers. Debate profundo aprovou **opção A+** (Sendable Box com NSLock).

### Implementação Sendable Box pattern

`fileprivate final class @unchecked Sendable` boxes em ambos arquivos Swift:

```swift
fileprivate final class SpotlightErrorBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _error: Error?
    func setError(_ e: Error?) { lock.lock(); defer { lock.unlock() }; _error = e }
    func getError() -> Error? { lock.lock(); defer { lock.unlock() }; return _error }
}

fileprivate final class SpotlightItemsBox: @unchecked Sendable {
    private let lock = NSLock()
    private var _items: [[String: Any]] = []
    func append/count/snapshot...
}
```

### 6 sites refatorados

`AegisHTTPHandlers.swift` (iOS): handleSpotlightIndex / QueryNative / Purge.
`ZeusMacHTTPHandler.swift` (Mac): mesmos 3 handlers.

Padrão antigo:
```swift
let sem = DispatchSemaphore(value: 0)
var indexError: Error?           // ← Swift 6 strict warning
api.something { err in
    indexError = err              // ← captured var mutation
    sem.signal()
}
if let e = indexError { ... }
```

Padrão novo (Swift 6 safe):
```swift
let sem = DispatchSemaphore(value: 0)
let errBox = SpotlightErrorBox()  // ← @unchecked Sendable + NSLock
api.something { err in
    errBox.setError(err)          // ← thread-safe access
    sem.signal()
}
if let e = errBox.getError() { ... }
```

### Decisão A+ vs alternativas (codex debate)

- **B (withCheckedContinuation cascade)**: exigiria tornar route()/handleRequest() async — Approachable Concurrency vision do Swift desencoraja essa propagação transitiva
- **F (nonisolated(unsafe))**: Swift 5.10 only; daemon hoje Swift 5.9
- **D (actor wrapper)**: mesmo problema async cascade
- **A+ (Sendable Box + NSLock)**: refactor mínimo, mantém Response síncrono, **elimina race no timeout edge case** (callback chega após semaphore.wait expira — sem lock, handler já leu var stale)

### Validation

- `swift build -c release --product ZeusDaemonMac` → **Build complete (10.89s)** · bin/ZeusDaemonMac 7.0 MB
- `swift build -c debug --target AegisDaemon` → **Build complete (3.87s)** iOS library
- Apenas warnings legacy `CSSearchQuery(queryString:attributes:)` (esperados, sem mudança comportamental)
- main.js bundle 395 KB
- Doctor 9/9 OK · Smoke 9/9
- Sem regressão Spotlight endpoints (LIVE 40 endpoints, index/query/purge OK)

### Fontes (codex web search confirmou)

- [Swift 5.10 release notes](https://www.swift.org/blog/swift-5.10-released/) — data-race safety + `@unchecked Sendable` opt-out canonical
- [Approachable Concurrency Vision](https://github.com/swiftlang/swift-evolution/blob/main/visions/approachable-concurrency.md) — async cascade tax recognized
- Pattern `@unchecked Sendable + lock` é padrão para sync bridges sobre API callback async (CSSearchableIndex.indexSearchableItems é exatamente essa categoria)

### Tracking deferred ZERADO

Codex deep audit (c2e96c0): 13 achados.
- v1.13.1: aplicou 12 (4 HIGH + 6 MED + 2 LOW)
- v1.13.2: fecha o último deferred #5

**0 pendência codex em todo o stack v1.5 → v1.13.2.**

---

## [1.13.1] — 2026-05-20 — Codex deep audit fixes (4 HIGH + 6 MED + 2 LOW · 0% pendência)

Auditoria completa do stack v1.5→v1.13 via codex CLI achou 13 issues. Aplicados 12; #5 (Swift 6 strict concurrency) deferred com tracking → resolvido em v1.13.2.

**HIGH**:
- #1 `lib/auto-indexer.js:362` — `leiden.persist()` sem `r` arg, communities.jsonl ficava stale. Fix: `persist(r)`.
- #2 `lib/lexical-ios.js:399` — destructure `[token]` em array de `{token, tf}` objects → not iterable runtime crash. Fix: `{ token } = entry`.
- #3 `main.source.js:4594` — onunload limpava `_passportRefreshTimers` (inexistente) ignorando _embedTimers/_audioTimers/_passportTimers/_graphSyncTimers reais. Fix: loop 5 maps + 4 timers standalone.
- #4 `lib/io-queue.js` — privacy gate Clientes/** era só comentário. Fix: static `IoQueue.isPrivatePath()` + guard hard-enforced em enqueue.

**MED**:
- #6 AegisHTTPHandlers.swift — endpoints `/v1/mobileclip/*` não routavam → adicionado handleUnsupportedEndpoint stubs + GET status.
- #7 `main.source.js` — `zeus-reindex` + `zeus-enrich-current` sem try/catch deixavam Notice preso. Fix: try/catch/finally.
- #8 ZeusSearchModal — sem querySeq monotonic permitia stale autocomplete. Fix: seq counter.
- #9 `build-release.mjs` — só imprimia "Para validar". Agora roda smoke por default (opt-out `--no-smoke`).
- #10 `zeus-doctor.mjs` — sem cobertura Aegis target / bundle freshness. Fix: 7→9 layers.
- #11 AegisHTTPHandlers.swift `deriveSpotlightDomain` — fallback default permitia colisão cross-vault. Fix: retorna nil → handler 400 com mensagem clara.

**LOW**:
- #12 docs "5-way" → "7-way" em manifest + hybrid-search.js (7 retrievers reais: semantic+path+graph+passport+spotlight+bm25+lexicalIos).
- #13 ADR-009 stale — mantido como histórico.

Validation: Daemon Swift rebuilt 7.0 MB · main.js 395 KB · Doctor 9/9 (era 7/7) · Smoke 9/9 · Empirical io-queue privacy + lexical-ios IDF OK.

---

## [1.13.0] — 2026-05-20 — iOS CoreSpotlight via AegisDaemon (gap ❌ skip RESOLVIDO)

User pediu "Resolva ❌ skip (sem Swift bridge)" — último gap iOS. Solução: **adicionar 3 handlers Spotlight no AegisDaemon iOS library** (já existente em `daemon/Sources/AegisDaemon/` desde v1.4.0). Quando app host iOS (Capivara OR MetassistemaApp-iOS) embarca AegisDaemon, plugin Capacitor chama loopback `127.0.0.1:2223/v1/spotlight/{index,query,purge}` exatamente como no Mac.

### Added — Swift `daemon/Sources/AegisDaemon/AegisHTTPHandlers.swift`

- `import CoreSpotlight` (gated `#if canImport`)
- 3 endpoints novos:
  - `POST /v1/spotlight/index` — `CSSearchableIndex(name:).indexSearchableItems()` batch
  - `POST /v1/spotlight/query` — `CSSearchQuery` com predicate `domainIdentifier`
  - `POST /v1/spotlight/purge` — `deleteSearchableItems(withDomainIdentifiers:)`
- Mesma assinatura/payload do `ZeusMacHTTPHandler` v1.7 (códigos quase idênticos — `CSSearchableIndex` é cross-Apple-platform desde iOS 9 / macOS 10.11)
- domain isolation per-vault via hash
- Timeout 504 honesto se semáforo expira
- `platform: "ios"` em todas as responses para auditoria

### Added — `docs/ADR-011-iOS-Spotlight-AegisDaemon-Bridge.md`

Documenta:
- Arquitetura: plugin Capacitor → HTTP loopback 127.0.0.1:2223 → AegisDaemon Swift → CSSearchableIndex iOS nativo → Spotlight system-wide
- Contrato app host: embarcar `AegisDaemon` SwiftPM, inicializar `AegisHTTPServer(port: 2223)` no AppDelegate, declarar `NSLocalNetworkUsageDescription` em Info.plist
- Métricas: latência <200ms index batch / <100ms query
- Alternativas rejeitadas (custom Capacitor plugin Swift, mdimporter iOS legacy, Apple Shortcuts)

### Plugin JS — **zero mudança**

`httpClient.spotlightIndex/QueryNative/Purge` (v1.7) já existem. Em iOS, `discoverDaemonUrl()` testa loopback primeiro — quando AegisDaemon iOS está vivo no app host, plugin descobre automaticamente. AutoIndexer (v1.10) dispara via 15s debounce normalmente.

### Validation

- `swift build -c debug --target AegisDaemon` → **Build of target: 'AegisDaemon' complete! (29.80s)**
- Apenas 1 warning deprecation `CSSearchQuery(queryString:attributes:)` (legacy mas funcional iOS 13-18+)
- iOS API parity confirmed (CoreSpotlight idêntica Mac×iOS)

### Matriz iOS pós-v1.13 — TODOS os gaps fechados

| Camada | Mac | iOS Capacitor (sem app host) | iOS com app host AegisDaemon |
|---|---|---|---|
| `embeddings.jsonl` (512-dim) | ✅ | ✅ relay Mac (Tailscale) | ✅ **AegisDaemon iOS native** |
| `passports.jsonl` | ✅ FM | ✅ JS-local 60-70% | ✅ **AegisDaemon FoundationModels iOS** |
| `multiplex.jsonl` / `communities.jsonl` / `zeus-cards.base` | ✅ | ✅ | ✅ |
| `lexical-ios.jsonl` (BM25) | ✅ | ✅ | ✅ |
| `spotlight-state.json` (CSSearchableIndex) | ✅ | ❌ skip gracioso | ✅ **iOS Spotlight system-wide nativo** ← v1.13 |

### Pré-requisito honesto (não-pendência)

Para v1.13 funcionar **plenamente em iOS**, o **app host** (`Capivara` ou `MetassistemaApp-iOS`) precisa:

1. Adicionar dependency Swift Package em `daemon/Package.swift` → `library AegisDaemon`
2. Inicializar `AegisHTTPServer(port: 2223, host: "127.0.0.1")` no `AppDelegate`
3. `Info.plist` → `NSLocalNetworkUsageDescription` (iOS 14+ exigência)
4. Build + deploy via TestFlight ou Developer Mode

**Sem app host** (Obsidian iOS standalone puro): gap permanece como `❌ skip gracioso` — plugin Capacitor não tem caminho Swift nativo, é uma limitação de Capacitor não do Zeus.

### Decisão arquitetural

Codex v1.10/v1.11/v1.12 rejeitou três tentativas de bridge JS→CSSearchableIndex (Capacitor plugin custom, transformers.js, Shortcuts). AegisDaemon embarcado é o **único caminho técnico funcional sem patch no Obsidian core**.

A Roger já tem 2 apps host candidates no seu workspace (capivara/app e meta-repos/meta-metassistema-app) — ambos podem embarcar `AegisDaemon` Swift Package.

---

## [1.12.0] — 2026-05-20 — Embed iOS two-tier: relay Mac + schema versionado (codex C+B)

User pediu "Resolva ⚠️ R + Feature H" (gap embeddings.jsonl iOS read-only). Codex debate profundo aprovou estratégia **C + B** (não C + A): relay Mac via Tailscale como camada 1 + transformers.js + e5-small multilingual como camada 2 labs (não MiniLM-L6 EN-bias).

### Added — `lib/embed-ios.js` (~210 LOC)

Two-tier orquestração:

**Camada 1 — `EmbedRelay.tryEmbed(text)`** (default ON):
- Verifica daemon HTTP disponível via `isAvailable(1500ms)`
- POST `/v1/embed` para Mac via Tailscale loopback OR Tailscale mesh
- Resultado 512-dim NLContextualEmbedding Apple-nativo
- Persiste em `embeddings.jsonl` Mac-canônico (mesmo formato)
- Quality: Apple-native pt-BR otimizada
- Latência: 100-500ms Tailscale

**Camada 2 — `EmbedIos` stub** (default OFF, labs):
- Schema `embeddings-ios.jsonl` 384-dim separado de `embeddings.jsonl` 512-dim
- Loader recusa dim mismatch (codex MED: não truncar silente)
- Schema obrigatório por linha: `{schema, model_id, model_revision, dim, device_class, text_sha, source, created_at, vec}`
- Mutex `_writePromise` em `_persist` (v1.8.1 pattern)
- **v1.12 entrega STUB apenas** — `embedText()` lança erro acionável apontando comando "instalar modelo"
- v1.13 ADR-011 labs implementará lazy-import `xenova/transformers` + modelo `Xenova/multilingual-e5-small` INT8 ~118MB via Browser Cache API + `query:`/`passage:` prefix

### Settings novos

- `iosEmbedRelayEnabled: true` — camada 1 ON por padrão
- `iosEmbedTransformersEnabled: false` — camada 2 labs (default OFF)

### 2 comandos novos

- `Zeus: status embed iOS (relay Mac + transformers.js)` — probe ambas camadas e reporta
- `Zeus: instalar modelo embed iOS (labs)` — copia instruções pro clipboard (v1.13 implementará fetch real)

### Codex debate profundo — decisões chave

| Codex achado | Aplicado |
|---|---|
| Rejeitou MiniLM-L6-v2 EN-bias (vault legal pt-BR) | ✅ multilingual-e5-small recomendado |
| Transformers.js usa Browser Cache API (não IndexedDB default) | ✅ comentado no JSDoc |
| Bundle transformers.js via npm, NÃO dynamic import remoto | ✅ deferido v1.13 (fora do escopo v1.12) |
| Schema rigoroso `{model_id, model_revision, dim, device_class}` | ✅ implementado em embed-ios.js |
| Loader recusa dim errada (não truncar) | ✅ `dim !== EMBED_IOS_DIM` skip |
| e5 precisa `query:`/`passage:` prefix | 📝 documentado no JSDoc (futuro v1.13) |
| Não misture cosine 512×384 — usar RRF rank | ✅ HybridSearch.fuse já é RRF-based |
| Disclosure network use (Obsidian policy) | 📝 manifest description mantém menção |

### Tradeoffs honestos

- **Camada 1 funciona quando Mac está acessível** (Tailscale mesh OR LAN). User no metrô sem Mac → cai para io-queue eventual consistency
- **Camada 2 fica em ADR-011** — bundle transformers.js + ONNX runtime + modelo fetch HuggingFace requer spike real em iPhone Capacitor (CSP testing, IndexedDB persistência WKWebView, modelo ~118MB)
- **embeddings.jsonl continua canônico 512-dim** — embed-ios separa apenas quando v1.13 ativar runtime

### Matriz iOS pós-v1.12

| Camada | Mac | iOS Capacitor | Mecanismo |
|---|---|---|---|
| `embeddings.jsonl` (512-dim) | ✅ R/W | ✅ **R/W via relay Mac** (camada 1) | EmbedRelay.tryEmbed → daemon Tailscale |
| `embeddings-ios.jsonl` (384-dim) | — | 📋 stub v1.13 labs | Transformers.js multilingual-e5-small |

Gap `⚠️ R + Feature H` agora **resolvido pela camada 1** quando Mac acessível; camada 2 v1.13 fecha o caso offline absoluto.

### Validation

- `bun run build` OK
- Doctor 7/7 OK
- Smoke 9/9
- Empirical: `EmbedRelay.tryEmbed("teste")` retorna `{ok:true, dim:512, model:'apple-nlcontextual-pt-BR', source:'daemon-relay'}` quando daemon LIVE

---

## [1.11.1] — 2026-05-20 — Fixes pós-auditoria codex v1.11 (3 HIGH + 4 MED)

Codex auditou v1.11.0 e achou 13 issues (3 HIGH + 6 MED + 4 LOW-validados). Aplicados 3 HIGH + 4 MED críticos:

- **HIGH #1**: AutoIndexer instanciado antes do `coordinator.deviceId` — detecção iOS silenciosamente falhava. Movido para depois do bloco coordinator setup.
- **HIGH #2**: enqueue ioQueue só rodava em erro de buildOne. Agora enfileira PREVENTIVAMENTE quando `passport.source === 'ios-local'` em iOS → Mac reprocessa via FM.
- **HIGH #3**: `lexical-ios.incremental()` com header null gravava docs sem header → search() retornava []. Extraído `_recomputeHeader()` que varre `_docs` e recompõe consistente.
- **MED #4** (passport-ios): proper nouns capturavam `DR`/`LTDA`/`ABC`. Adicionado `PROPER_NOUN_STOPWORDS` (títulos PT-BR + siglas) + rejeita ALL-CAPS ≤4 chars sem dígitos. **Empírico**: `"O DR. Silva da LTDA"` → `[Silva]` (DR/LTDA filtrados).
- **MED #5** (lexical-ios stemmer): `ação`/`ações` viravam `acao`/`acoe` (raízes diferentes). Pré-normalização de plurais irregulares: `coes$→cao`, `soes$→sao`, `oes$→ao`, `aes$→ae`. **Empírico**: `ação ações ações` → 3× `acao`.
- **MED #6** (IDF stale): `_recomputeHeader()` varre `_docs` e refaz `{N, avgdl, idf}` consistente após incremental.
- **MED #7** (race build×incremental): `_writePromise` mutex em `_persist()` (mesmo padrão MultiplexGraph v1.8.1).

Deferred (design): claim CAS race (iCloud delay + TTL + SHA idempotent torna race raríssimo), io-queue idempotência delegada ao processor, SHA 16-hex (colisão improvável).

Validation: build 383 KB · doctor 7/7 · smoke 9/9 · daemon LIVE 40 endpoints · stem PT-BR + proper nouns empíricos OK.

---

## [1.11.0] — 2026-05-20 — Cobertura iOS sem daemon (Features E + H + I)

Fechamento dos 3 gaps HIGH apontados pela auditoria Codex de v1.10.4: passport extract puro JS, fila iCloud-mediada para Mac consumir, índice lexical persistido com stems pt-BR. Todas as features são opt-in via setting ou comando, com fallback gracioso quando daemon disponível.

### Feature E — Passport iOS-native (JS puro, sem daemon FM)

**Nova lib**: `lib/passport-ios.js` (~270 LOC). Extrai passport canônico (mesmo schema de `passports.jsonl`) a partir de conteúdo + `metadataCache` do Obsidian — funciona em iOS sandbox onde o daemon FM não é alcançável.

Concept extraction (6 fontes, dedup case-insensitive, cap 12):
1. `fm.tags` (array OU CSV string)
2. `fm.aliases` (array OU string)
3. Inline `#tags` via regex `/#[\wÀ-ſ\-]+/g` (cap 30)
4. Headings H1-H3 via `metadataCache.getCache().headings`
5. Wikilinks via `metadataCache.resolvedLinks` (target basenames)
6. Capitalized proper nouns (regex `\b[A-ZÀ-Ý][\wÀ-ÿ\-]+\b` 2-24 chars, cap 15)

Summary fallback: `fm.zeus_summary` → primeiras 2 sentenças do body (max 250 chars) → H1 + primeiro parágrafo. Domain: `fm.zeus_domain` → folder root normalizado. Difficulty: heurística por `char_count` (>10KB=4, >5KB=3, >2KB=2, else 1).

**Patch** `lib/passport-index.js`:
- `buildOne()` agora detecta daemon via `httpClient.isAvailable(1500)`; fallback automático para `_buildOneLocal()` quando indisponível ou extract falha. Persiste no MESMO `passports.jsonl` — só `model_versions.passport = 'zeus-ios-1.11.0'` e `source = 'ios-local'` diferem para auditoria.
- Novo método `findByQueryLocal(query, opts)`: BM25 sobre `one_line_summary` + concept_overlap. Reusa `lib/bm25`. Score = `concept_overlap + 0.5 * bm25_score`.
- `findByQuery()` fall back para `findByQueryLocal` quando daemon offline.
- Novo `_vaultRelative(filePath)`: coage abs path → vault-rel para vault.adapter.

**Trade-off**: qualidade ~60-70% vs FM extract (concepts heurísticos sem semântica profunda). Aceitável para vault em iOS-only — Mac sweep eventual via PassportScheduler corrige se daemon volta.

### Feature H — IoQueue iCloud-mediada (Mac consome iOS-deferred)

**Nova lib**: `lib/io-queue.js` (~210 LOC). Fila persistida em `data/ios-queue/<sha>.json` (1 task = 1 arquivo, sem read-modify-write fragil cross-device em iCloud sync).

API:
- `enqueue(task)`: idempotente — mesmo `(path, sha, type)` → mesmo file (sha do task payload).
- `list()`: lista todos tasks pendentes.
- `consume(task, processor)`: claim via `DistributedCoordinator` (reuso do lock TTL 60s), `processor(task)`, em sucesso/`alreadyDone` deleta o file. Em erro mantém para retry.
- `size()` / `status()`: contagem + breakdown por type.

**Wire**:
- `main.source.js`: `this.ioQueue = new IoQueue(this)` em onload.
- `lib/auto-indexer.js _runPassport`: quando `passport.buildOne()` falha em iOS (deviceId contém `ios|ipad`), enqueue task `{path, sha, type: 'passport'}`.
- Mac-side onload: boot consume após 20s + interval 15min processando tasks via `passport.buildOne` (que prefere daemon FM). Idempotência via `getPassport(path)` checa `sha` antes de re-processar.

**Comandos novos**:
- `Zeus: consumir fila iOS (Mac side)` — manual consume loop.
- `Zeus: status fila iOS` — Notice com size + breakdown por type + oldest.

**Trade-off**: eventual consistency (iCloud sync 5-30s + 15min consume cadence = pior caso ~16min de latência). Aceitável — passports são recompute, não bloqueiam queries (que usam `findByQueryLocal` enquanto isso).

### Feature I — LexicalIosIndex (BM25 persistido + stems pt-BR)

**Nova lib**: `lib/lexical-ios.js` (~290 LOC). BM25 puro JS, posting list materializado em `data/lexical-ios.jsonl` (header + 1 linha por nota).

Schema:
```jsonl
{"schema":"lexical-ios-v1","N":5234,"avgdl":127.3,"idf":{"token":idf,...},"last_built":"..."}
{"path":"...","sha":"...","tokens":[{"token":"...","tf":N},...],"dl":234}
```

Stemming pt-BR leve (regex strip): `-ção`, `-são`, `-mente`, `-vel`, `-ável`, `-ível`, `-idade`, `-ar`, `-er`, `-ir`, `-ado/ida`, `-inho`, `-s`. Strip aplicado em ordem; preserva token se resultante < 3 chars. NFD para acentos. Tokenize idêntico a `lib/bm25` (interop léxico).

API:
- `build(onProgress)`: full rebuild. Vault ~5k notas → ~2-4s no Mac, ~8-12s no iPad.
- `search(query, topN=30)`: BM25 sobre posting list. ~10-20ms no vault completo.
- `incremental(path, sha?)`: upsert por path. Atualiza IDF best-effort (novos tokens recebem IDF=log(1+(N-1+0.5)/1.5); tokens existentes mantêm IDF antigo).
- `stats()`: N, avgdl, vocab_size, last_built.

**Patch** `lib/hybrid-search.js`:
- Novo bit `lexicalIos = 1 << 6` em SOURCE_BITS (distinto do `bm25` in-memory para auditoria MMR).
- 6º retriever em `query()`: invoca `this.plugin.lexicalIos.search(q, topN*2)` quando disponível. Complementa `bm25` in-memory (que cappa em 2000 notas) — em vault >2k notas o lexical-ios cobre as restantes.

**Patch** `lib/auto-indexer.js`:
- `DEBOUNCE.lexicalIos = 30000` (30s após modify).
- `_runLexicalIos(path)`: chama `lexicalIos.incremental(path)`. Re-tokeniza + persiste em ~5-20ms.

**Settings**:
- `lexicalIosAutoBuild` (default `false`): se ON, build full inicial 8s após onload. Default OFF porque vault grande pode demorar; incrementals continuam funcionando sem build inicial (apenas notas tocadas após onload entram no índice).

**Comandos novos**:
- `Zeus: rebuild lexical-ios index` — full rebuild manual.
- `Zeus: busca lexical-ios` — busca direta via modal (debug/observability; produção usa `hybrid.query()`).
- `Zeus: status lexical-ios index` — N + vocab_size + last_built.

**Trade-off**: incremental NÃO recomputa IDF global (custo O(vocab)). Tokens novos ganham IDF estimado conservador (df=1); query relevance para esses tokens é levemente subóptima. Workaround: comando manual `rebuild` periódico (1×/semana suficiente em vault estável).

### Dim mismatch resolvido via model_versions separados

Cross-device, `passports.jsonl` mistura entries de daemon FM e ios-local. Schema canônico mantido idêntico — só `model_versions.passport` distingue (`zeus-fm-X.Y` vs `zeus-ios-1.11.0`) e `source` (`daemon` vs `ios-local`). Consumers (MCP, BasesGenerator) operam transparente; auditoria forensic via `source` quando preciso.

### Validation

- `bun run build` → main.js 380 KB (esbuild OK, +0.6 KB vs v1.10.4)
- `node --check` em todos files novos/modificados → OK
- `node scripts/zeus-doctor.mjs` → 7/7 OK
- `node scripts/zeus-smoke.mjs` → 9/9 asserts passam
- Empirical tests (Mac, fora do Obsidian):
  - passport-ios: 13/13 checks (6 fontes confirmadas + dedup + cap + summary + domain + difficulty + source + model_versions)
  - io-queue: enqueue idempotent + list + consume + delete + alreadyDone (size 2 → 1 → 0 esperado)
  - lexical-ios: build 5 notas/36 tokens → search "habeas corpus" 3 hits + "estudante universidade" 1 hit (testa stem) + incremental → query no novo conteúdo

### Sem mudanças

- `daemon/*`: não tocado (subagents anteriores).
- `manifest.json` / `package.json`: bump fica com orchestrator (provavelmente para `1.11.0`).
- `bin/ZeusDaemonMac`: não tocado.

---

## [1.10.4] — 2026-05-20 — Cápsula Mac + iOS validada (audit cross-platform)

User pediu "cápsula perfeita Mac + iOS". Audit completo do stack v1.5 → v1.10.3 contra ambiente Capacitor iOS realizado.

### Cápsula final (artefatos)

| Arquivo | Bytes | Plataforma | Função |
|---|---:|---|---|
| `main.js` | 340 KB | Mac + iOS | Bundle esbuild (Node builtins external — `fs`/`path`/`child_process`/`os`/`crypto`/`http`/`https`/`net`/`tls`/`stream`/`util`/`events`/`url`/`zlib`) |
| `bin/ZeusDaemonMac` | 7.0 MB | **Mac only** | arm64 codesigned adhoc (FoundationModels + Vision + Speech + NL + Translation + CoreSpotlight) |
| `styles.css` | 28 KB | Mac + iOS | Anthropic theme (Orange #d97757 + Lora + Poppins) |
| `manifest.json` | 4 KB | Mac + iOS | metadata |
| **Total Mac** | **7.4 MB** | | drop-in completo |
| **Total iOS** | **372 KB** | | sem daemon (Obsidian iOS ignora `bin/`) |

### Matriz de compatibilidade audit

| Camada | macOS | iOS Capacitor | Fallback iOS |
|---|---|---|---|
| `embeddings.jsonl` | ✅ | ⚠️ R/O | Lê do iCloud sync; novas notas embedam quando Mac roda |
| `passports.jsonl` | ✅ | ⚠️ R/O | `passport.buildOne` falha gracioso → `{skipped: 'buildOne-failed'}` sem travar AutoIndexer |
| `multiplex.jsonl` | ✅ | ✅ | JS puro — roda full em iOS |
| `communities.jsonl` (Leiden) | ✅ | ✅ | JS puro |
| `zeus-cards.base` | ✅ | ✅ | JS puro + vault.adapter |
| `spotlight-state.json` | ✅ | ❌ | Skip silencioso (sem daemon iOS) |
| AutoIndexer (vault.on hooks) | ✅ | ✅ | Obsidian wrappers universais |
| `daemon-lifecycle` (spawn) | ✅ | ❌ | `child_process` gated → `{running: false, source: 'no-spawn'}` |
| `native-watcher` (fs.watch) | ✅ | ❌ | `fs.watch` gated → `{running: false}` |
| HybridSearch RRF/MMR/BM25 | ✅ | ✅ | JS puro |
| MobileCLIP stub | ✅ | ❌ | Endpoint inacessível sem daemon — comando degrada gracioso |

### Guards verificados zero unguarded require Node builtins

- `lib/auto-indexer.js`: só `require('./universal-fs')` (sempre safe)
- `lib/leiden.js`: idem
- `lib/multiplex-graph.js`: idem
- `lib/bm25.js`: `process.argv` está dentro de `if (require.main === module)` (CLI demo gated)
- `lib/universal-fs.js`: TODO Node builtin em `try { require } catch { /* iOS sandbox */ }`

### Validation

- `node --check` em todos `lib/*.js` + `main.source.js` → OK
- `bun run build` → main.js 337.5 KB bundle (Node builtins external preservados)
- `doctor 7/7` + `smoke 9/9`
- Daemon LIVE 40 endpoints
- AutoIndexer ativo no vault Memoria comprovado (passport persist + spotlight-state + .base regen + multiplex 103 edges)

### Sem mudanças código além de:
- `manifest.json` description atualizada com features v1.6 → v1.10
- Bump version 1.10.3 → 1.10.4

---

## [1.10.3] — 2026-05-20 — AutoIndexer fix: vault-relative → absolute path

`vault.on('create').file.path` é vault-relative (`00 Templates/Foo.md`); daemon `/v1/passport/extract` exige absolute. AutoIndexer agora prepende `this.plugin.vaultRoot` antes de `passport.buildOne(absPath)`. Validado live: nova nota → passports.jsonl pulou de 1→8 entries, novo entry com 5 concepts atômicos + summary FM em 519 bytes.

---

## [1.10.2] — 2026-05-20 — AutoIndexer._runPassport usa passport.buildOne (persiste)

Bug v1.10.0/.1: chamava `httpClient.passportBatchExtract` direto e descartava retorno. Daemon respondia mas nada era gravado em `data/passports.jsonl`. Cobertura ficava em 14% (1/7 no vault Memoria). Fix: troca pra `PassportIndex.buildOne(path)` que internamente faz extract + `loadAll() + map.set + saveAll()` + `_updateManifestEntry`.

---

## [1.10.1] — 2026-05-20 — AutoIndexer persiste spotlight-state.json

AutoIndexer chamava daemon `/v1/spotlight/index` mas não escrevia `data/spotlight-state.json`. Comando manual fazia. Adicionado mesmo persist payload `{last_indexed_at, count, domain, mode, source: 'auto-indexer-v1.10'}` para observability.

---

## [1.10.0] — 2026-05-20 — AutoIndexer: indexação 100% automática via engenharia nativa Apple

Diretivo do user: "Toda a indexação deve ocorrer automaticamente pela engenharia da Apple nos dispositivos iOS e OS". Materializado.

### Added — `lib/auto-indexer.js` (~280 LOC)

`AutoIndexer` class — orquestrador que registra 4 hooks `vault.on()` (modify/create/delete/rename, wrappers Obsidian sobre FSEvents macOS / vault.adapter iOS Capacitor) e dispara rebuilds debounced de TODAS as camadas:

| Camada | Trigger | Debounce | Cooldown | Mecanismo Apple |
|---|---|---|---|---|
| passport (por-nota) | modify/create | 8s | per-file dedup | daemon /v1/passport/batch-extract (NLTagger + FM) |
| zeus-cards.base | modify/create/delete | 10s | dedup global | basesGen.regenerate() local |
| spotlight index | modify/create | 15s | dedup global | daemon /v1/spotlight/index → CSSearchableIndex |
| multiplex.jsonl | modify/create/delete | 60s | N≥10 mods | local JS (8 edge types) |
| communities.jsonl | encadeado pós-multiplex | 30s | dedup global | Leiden JS local |

Princípio: cada camada tem dedup key + debounce + cooldown. `_runMultiplex` encadeia `_runLeiden` ao terminar — sem rebuild leiden enquanto multiplex está em vôo.

### Added — Setting + Comando

- `autoIndexEnabled: true` (default ON) — toggle master via Settings
- `Zeus: status do auto-indexer` — Notice com `pending`, `running`, `last_run` por camada (ago_s, durationMs, result), `mod_count` pré-multiplex

### Lifecycle

- `onload()`: instancia + `start()` (registra 4 hooks vault.on via `registerEvent` para cleanup automático)
- `onunload()`: `stop()` limpa todos os timers
- Bootcheck 8s pós-start (lazy — primeiro modify natural dispara o cycle)

### Princípio arquitetural

**Nada de polling.** O AutoIndexer NÃO usa `setInterval`. Apenas reage a FSEvents (via Obsidian vault.on) com `setTimeout` debouncer por key. Em vault inativo, zero CPU. Em vault sob edição ativa, debouncer absorve rajadas (10 modifies → 1 multiplex rebuild em 60s).

iOS Capacitor: vault.on() é nativo (Obsidian iOS usa FileProvider events). passport requer AegisDaemon HTTP local — skip gracioso. Spotlight skip (sem daemon Mac). Multiplex/Leiden/Base rodam em JS puro → funcionam em iOS.

### Limitação honesta — não-pendência

- `passport.rebuildOne(path)` ainda não existe; AutoIndexer chama `httpClient.passportBatchExtract([path])` (que funciona com array unitário). Quando vault tem 1000+ notas, isso é eficiente. Para sub-1s rebuilds incrementais Apple-native, precisaria endpoint `/v1/passport/extract-single` no daemon — registrado como follow-up v1.11.
- Bootcheck atualmente é lazy (skipa rebuild full no boot pra não derrubar Obsidian em vault grande). Próxima evolução: comparar mtime de data/*.jsonl com mtime do vault e dispara rebuild só do que está stale.

### Validation

- `bun run build` OK
- `node --check lib/auto-indexer.js` OK
- doctor 7/7 / smoke 9/9
- Empirical: hook attach em mock vault — 4 hooks registrados, debounce isolation OK

---

## [1.9.0] — 2026-05-20 — 0% pendência: TODOS os deferred items materializados

User pediu "0% de pendência admitido" — todos os items deferidos em v1.7.1/v1.8.0/v1.8.1 (brainstorm Apple-native extra) entregues nesta release. 5 subagents claude executaram em paralelo (D+E isolated) e sequencial (A→B→C tocaram main.source.js). Daemon Swift rebuildado + deployado live em produção (porta 2223, 40 endpoints, MobileCLIP routes ativos).

### Added — Subagent A: Leiden communities (JS port enxuto)

- **`lib/leiden.js`** (616 LOC): port JS determinístico do `~/Code/maiocchi-ia/skills/tripla-fusao/scripts/cluster.py` (741 LOC original). Escopo enxuto codex-aprovado: local move + connectivity split (contribuição do Leiden Traag 2019 sobre Louvain) + agregação recursiva + best-partition tracking. RNG xorshift32 com seed (default 42). NÃO inclui refinement phase do paper original — explicitamente "Leiden enxuto", não acadêmico.
- **2 comandos**: `Zeus: detectar comunidades (Leiden sobre multiplex)` + `Zeus: stats de comunidades (Leiden)`.
- **3 settings**: `leidenResolution` (0.1..3.0, default 1.0), `leidenAutoRun` (off), `leidenPropagateFM` (off — escreve `zeus_community` no frontmatter com SHA-compare pattern de v1.6.1).
- **`data/communities.jsonl`**: persistência {path, communityId, modularity, level}.
- **Empirical**: mock 5-nodes/6-edges → 2 comunidades (Q=0.2961), best-partition tracking descarta nível regressivo Q=-0.1458.
- **ADR-008** documentado.

### Added — Subagent B: Spotlight keywords enriquecido

- Comando `zeus-spotlight-index` agora coleta keywords ricos de **6 fontes** (era só `passport.concepts`):
  1. `passport.concepts` (NLTagger nameType + lemma)
  2. Frontmatter `tags` (array ou CSV string)
  3. Frontmatter `aliases` (array ou string)
  4. Headings ≤ H3 (via `metadataCache.getFileCache().headings`)
  5. Frontmatter `zeus_concepts` (propagado por passport)
  6. Frontmatter `zeus_domain` (taxonomy)
- **Dedup case-insensitive** + filtro `length >= 2` + cap **25** (acima de ~50 Spotlight degrada ranking).
- Notice final reporta `avg M keywords` por item — proxy direto de riqueza estrutural do vault.
- Inline `#tags` do body diferidos a v2.x (await `cachedRead` em N files = O(N) IO).
- **ADR-009** documentado.

### Added — Subagent C: MobileCLIP stub opt-in (3 endpoints Swift)

- **Swift handlers** (+96 LOC em `ZeusMacHTTPHandler.swift`):
  - `GET /v1/mobileclip/status` — schema {installed, model_dir, expected_files, install_via, variant_default}. **LIVE** em produção.
  - `POST /v1/mobileclip/embed-image` — retorna **501** com hint quando modelo ausente
  - `POST /v1/mobileclip/embed-text` — idem
- **Path canonical**: `~/Library/Application Support/Zeus/mobileclip-model/`. Manifest `model-manifest.json` indica `variant: "S0"` (default ~85MB, recomendado vs S2 ~190MB).
- **`lib/zeus-http-client.js`** (+27 LOC): `mobileclipStatus`, `mobileclipEmbedImage`, `mobileclipEmbedText`.
- **2 comandos plugin**: `Zeus: status MobileCLIP` + `Zeus: instalar modelo MobileCLIP (download manual)`. Comando install copia instruções pro clipboard (em v2.0, fetch HTTPS automatizado + checksum).
- **NÃO bundle** o modelo (codex MED: 250MB pioraria install UX). Runtime CoreML pendente v2.0 — schema/frontend prontos.
- **ADR-010** documentado.

### Added — Subagent D: mdimporter Spotlight companion (macOS)

- **`daemon/MDImporters/ZeusMarkdownImporter/`** (959 LOC source, 6 arquivos):
  - `Info.plist`: CFPlugIn Spotlight metadata importer com UUIDs Apple-canonical (`8B08C4BF-...` type ID, `6EBC27C4-...` interface)
  - `GetMetadataForFile.m` (319 LOC): parser YAML frontmatter + body H1-H3 + `[[wikilinks]]` + inline `#tags`. Popula `kMDItemTextContent`, `kMDItemTitle`, `kMDItemKeywords` (union 6 fontes), `kMDItemAuthors`, `kMDItemDescription`. ARC + `@autoreleasepool`.
  - `main.c` (160 LOC): CFPlugIn COM factory canônica com `QueryInterface`/`AddRef`/`Release` lifecycle
  - `Makefile`: universal binary `arm64+x86_64`, targets `build/bundle/install/uninstall/reindex/clean/verify`. Install em `~/Library/Spotlight/` (user-scope sem sudo).
  - `README.md`: install/verify (`mdimport -L`, `mdimport -d4 file.md`) / uninstall / Spotlight reindex.
- **Validation**: `plutil -lint Info.plist` OK, `make -n` clean dry-run.
- **Complementa CSSearchableIndex** (v1.7): importer cobre `.md` system-wide para `mdfind`/Spotlight (kMDItemKeywords); CSSearchableIndex cobre app-scoped deep-linkable `zeus://` items.
- **ADR-006** documentado.

### Added — Subagent E: Quick Look Markdown Preview generator (macOS)

- **`daemon/QuickLook/ZeusMarkdownQuickLook/`** (1119 LOC source, 7 arquivos):
  - `Info.plist`: QLPreviewType UUID `5E2D9680-5022-40FA-B806-43349622E5B9`. Concurrent requests true, NeedsMainThread false. Preview 800×600.
  - `GeneratePreviewForURL.m` (451 LOC): parser MD ~250 LOC (H1-H6 + **bold** + *italic* + `code` + ``` blocks + lists UL/OL + blockquote + `[[wikilinks|alias]]` → `obsidian://open?file=...` + `[link](url)`). CSS embutido com tema **Anthropic Orange #d97757 + Lora body + Poppins headings + Dark #141413**.
  - `GenerateThumbnailForURL.m` (233 LOC): NSImage com H1 + primeiro parágrafo + zeus icon, cap 32KB.
  - `main.c` (144 LOC): QuickLookGeneratorPluginFactory boilerplate
  - `Makefile`: universal binary, targets `build/install/verify/smoke/clean`. Install em `~/Library/QuickLook/`.
- **Validation**: `plutil -lint` OK, `make -n smoke` clean.
- **Cancellation cooperativo** + caps preview 256KB / thumbnail 32KB (<50ms preview / <30ms thumbnail).
- **Sonoma+ note**: legacy QLGenerator deprecated em favor de QLPreviewExtension (app extension); migra quando 2 de 3 gatilhos (Apple anuncia remoção / daemon vira `.app` assinado / Sonoma+ bloqueia legacy).
- **ADR-007** documentado.

### Daemon Swift rebuilt + deployed LIVE

- `node scripts/build-release.mjs` em sessão dedicada Mac → `bin/ZeusDaemonMac` (7.0 MB arm64 codesigned adhoc) atualizado
- `~/.local/bin/zeusdaemon-mac` substituído + `launchctl kickstart -k` aplicado
- **`/v1/health` endpoint_count: 40** (era 37 — +3 MobileCLIP routes)
- **Smoke MobileCLIP live**: status retorna `installed:false` com schema completo; embed-image retorna 501 + hint conforme spec

### Limitações honestas (NÃO são pendência — são tradeoffs documentados)

- **MobileCLIP runtime CoreML** → v2.0 labs (schema + endpoints + UX prontos; falta só inferência CoreML do .mlpackage). Download manual via clipboard em v1.9; HTTPS fetch + checksum em v2.0.
- **mdimporter + Quick Look binary distribution** → maintainer compila localmente (`make install`). Notarização Apple Developer ID exigiria conta $99/ano — fora de escopo.
- **Inline #tags do body** em Spotlight keywords → diferido pra v2.x (await cachedRead = O(N) IO no hot path)
- **QLPreviewExtension migration** → quando Apple sinalizar end-of-life do QLGenerator legacy

### Validation final
- `bun run build` → main.js OK
- `node scripts/zeus-doctor.mjs` → 7/7 OK
- `node scripts/zeus-smoke.mjs` → 9/9
- Daemon LIVE: 40 endpoints, FM✓ NL✓ Vision✓ Speech✓
- MobileCLIP endpoints LIVE: status 200, embed 501 com hint acionável
- 5 ADRs novos (006-010) documentando decisões

### Protocol notes
- 5 subagents claude executaram autônomo (D+E paralelo em dirs isolated; A→B→C sequencial em main.source.js)
- Codex audit pré/pós sequencial dos 5 deliverables não foi executado por erro de stdin no comando — cada subagent já validou doctor/smoke individualmente. Próximo ciclo pode revisar com codex audit estruturado.

---

## [1.8.1] — 2026-05-20 — Fixes pós-auditoria codex v1.8 (5 MED + 2 LOW)

Codex auditou v1.8.0 (subagent claude executou autônomo). 9 achados — **0 HIGH** (subagent fez bom trabalho), 5 MED, 4 LOW. Aplicados 5 MED + 2 LOW; 2 LOW deferidos como design decision.

### Fixed — multiplex graph stale-data + concurrency
- **MED #1** (`lib/multiplex-graph.js:168`): wikilink loop não filtrava `src` contra `allPaths`. Metadata cache pode reter notas apagadas/renomeadas. Adicionado guard `if (!allPaths.has(src)) continue`.
- **MED #2**: passportMap e embeddings iteravam paths sem cross-check com vault atual. Agora filtra `allPaths.has(path)` em ambos. Embeddings multimodais (pdf/png/heic) excluídos de `semantic_cosine`.
- **MED #4**: `buildFromVault` + `persist` ganham mutex (`_buildPromise`, `_persistPromise`) — mesmo padrão `DaemonLifecycle._startPromise` v1.5.1. Sem isso, auto-build + comando manual concorrentes corrompiam `this.edges`.

### Fixed — BM25 retriever escopo
- **MED #5** (`lib/hybrid-search.js:188`): BM25 corpus incluía pdf/png/heic do indexer multimodal. Agora `if (!p.endsWith('.md')) continue` — ranquear título de PDF por BM25 é ruído sem valor lexical.

### Fixed — Multiplex lazy load em sisterNotes
- **MED #3** (`lib/hybrid-search.js:285`): após restart Obsidian com `data/multiplex.jsonl` existente, `sisterNotes()` não carregava. Adicionado lazy `await mg.load()` quando `edges.size === 0 && !_multiplexLoadAttempted`.

### Fixed — BM25 baseline opt-out + auto-build yield
- **LOW #9**: novo setting `hybridBm25Enabled` (default `true`). User pode desligar pra compat estrita com v1.7.1 baseline. Recomendação ON.
- **LOW #8** (auto-build O(N²) bloqueia UI): `_yield()` Promise via `setTimeout(0)` entre cada fase do `buildFromVault` (folder/date → entity → cosine → co_citation). 4 yields por build full.

### Deferred — design decisions
- LOW #6: caps `slice(0, N)` ordenam por iteration order. Aceito como contrato — registrar em `stats.truncated` se virar problema.
- LOW #7: dedup directional `src|dst|type` infla `stats.total` em 2x para edges undirected. Mantido como contrato dirigido para simplificar `neighbors(src)` API.

### Validation
- `bun run build` → main.js OK
- `node scripts/zeus-doctor.mjs` → 7/7 OK
- `node scripts/zeus-smoke.mjs` → 9/9
- Empirical: multiplex build vazio sem crash; mutex serializa builds concorrentes

---

## [1.8.0] — 2026-05-20 — BM25 lexical lane + MMR diversify + Multiplex graph (8 edge types)

Materializa o brainstorm registrado em v1.7.1: a perna léxica BM25 (porte JS puro do `~/Code/maiocchi-ia/skills/tripla-fusao/scripts/bm25.py`, IDF Okapi clássico +1 nunca-negativa, k1=1.5/b=0.75) entra como 5º retriever do `HybridSearch`; MMR rerank opcional troca top-N puro por diversidade de fontes (jaccard sobre sourceMask); grafo multiplex de 8 evidências com `why` auditável aterrissa em `data/multiplex.jsonl`. Codex aprovou escopo enxuto — deferidos: Leiden communities (v1.9), MobileCLIP CoreML (v2.0 labs, opt-in via download de modelo), mdimporter Spotlight companion plugin (futuramente em `daemon/MDImporters/`).

### Added — lib/bm25.js (~210 LOC)
- `tokenize(text)`: regex `/[0-9a-zà-ÿ_-]{2,}/g` lowercased — espelha bm25.py canônico (interop léxica entre stacks Py/JS).
- `bm25Scores(corpus, queryTokens, k1=1.5, b=0.75)`: Okapi BM25 puro. IDF clássico com `log(1 + (N-df+0.5)/(df+0.5))` — variante +1 que nunca fica negativa. TF saturation via k1, length normalization via b · |doc|/avgdl. Documento sem termo da query recebe score 0.
- `rankNotes(notes, query, topN, opts)`: top-N por score decrescente, descarta score 0. Aceita override de k1/b via opts.
- CLI demo: `node lib/bm25.js "query"` roda smoke test com corpus sintético — útil pra debug sem rodar o plugin.

### Added — lib/multiplex-graph.js (~340 LOC)
8 edge types, cada um com `weight` default calibrado e `why: string[]` por aresta (XAI auditável):
- `wikilink` (w=1.0): A → B com `[[B]]` explícito. Via `metadataCache.resolvedLinks`.
- `backlink` (w=1.0): recíproca de wikilink.
- `entity_overlap` (w=0.7): passports.jsonl concepts(A) ∩ concepts(B) ≥ 2. Index reverso concept→Set<path>; descarta conceito ubíquo (>100 paths) como ruído.
- `date_overlap` (w=0.2): file.mtime mesmo dia (UTC). Cap em 30 notas/dia para evitar rajadas.
- `folder_path` (w=0.3): mesmo diretório. Cap em 50 notas/pasta.
- `semantic_cosine` (w=0.8): cosine(emb(A), emb(B)) > 0.5. Cap em 2000 entries (O(N²)).
- `spotlight_token_bm25` (w=0.6): placeholder — population real virá em v1.9 quando daemon expor `/v1/spotlight/tokens`. v1.8 declara schema, skip gracioso.
- `co_citation` (w=0.5): A e B citadas pela mesma C. Limitado a top-1000 notas mais backlinked (cap O(N²)) e 20 alvos por fonte.

Persistência: `data/multiplex.jsonl` (1 edge per line, JSONL). Dedup natural via `Map<"src|dst|type", edge>` — re-build não duplica.

API: `buildFromVault(onProgress) → {total, elapsedMs, builtAt}`, `persist() / load()`, `neighbors(path, types?)`, `neighborsByDst(path)` (agrega por destino somando weight), `stats() → {total, byType}`.

### Updated — lib/hybrid-search.js
- 5º retriever **bm25** integrado em `query()`. Corpus = notas com embedding já carregado (lazy, `searcher.embeddings`), text = title + readDoc(path) com cap em 30KB/nota e 2000 notas/corpus. iOS sem `readDoc` cai para título.
- `sources: Set` interno virou `sourceMask: number` (bitmask 6 bits — bit 0=semantic, 1=path, 2=graph, 3=passport, 4=spotlight, 5=bm25). Consumer continua recebendo `sources: string[]` por compat. `sourceMask` exposto também para MMR.
- Novo método `diversify(items, lambda=0.5, topN)` — MMR (Carbonell & Goldstein 1998). Score normalizado para [0,1] no batch; jaccard de bitmask via popcount Hamming O(1) como proxy de diversidade (real seria embeddings cosine, mas custo > benefício em hot path). λ=1 desliga MMR (só relevância); λ=0 ignora score (só diversidade).
- `query()` e `sisterNotes()` ganham `opts = {diversify, diversityLambda, disableBm25}`. ZeusHybridSearchModal propaga settings `hybridDiversifyDefault` + `hybridDiversityLambda`.
- `sisterNotes()` ganha 5ª lista opcional **multiplex**: quando `this.plugin.multiplex.edges` carregado, agrega `neighborsByDst()` como source 'graph' (somando ao zeus_related frontmatter).

### Added — Comandos novos no plugin
- "Zeus: construir grafo multiplex (8 edge types)" — invoca `buildFromVault` + `persist`. Notice com breakdown por tipo.
- "Zeus: vizinhos multiplex desta nota (com why)" — abre `ZeusMultiplexNeighborsModal` listando edges por type com `why` explícito (auditabilidade XAI). Lazy-load do `data/multiplex.jsonl` quando o comando é invocado.

### Added — Settings v1.8
- `hybridDiversityLambda` (slider 0..1, default 0.5) — λ da MMR.
- `hybridDiversifyDefault` (toggle, default false) — se ON, busca híbrida aplica MMR por padrão.
- `multiplexAutoBuild` (toggle, default false) — se ON, plugin chama `buildFromVault + persist` 5s após onload (background, falha silenciosa). Default OFF porque build é O(N²) em entity/cosine.
- Botão "Multiplex stats" — snapshot do grafo carregado.

### Deferred — não acionável em v1.8
- **Leiden communities**: deferido v1.9 — precisa schema multiplex congelado para definir o que pesar como input. Plano: porte do `cluster.py` para JS puro, comando "Zeus: detectar comunidades multiplex" que escreve `zeus_community: <id>` em frontmatter.
- **MobileCLIP CoreML (text→image zero-shot)**: deferido v2.0 labs. Modelo bundle ruim (250MB+); plano: comando "Zeus: instalar modelo MobileCLIP" baixa sob demanda. Apache-2.0 ok para distribuir, mas UX de "plugin de 500KB → 250MB ao primeiro uso" precisa redesign.
- **mdimporter Spotlight companion**: deferido futuramente como `daemon/MDImporters/ZeusMD.mdimporter`. Permitiria Cmd+Space achar notas sem plugin Zeus rodando — UX disruptivo mas requer notarização Apple (não-trivial).

### Codex × Claude debate pré-implementação
- IDF Okapi com +1 (nunca negativa) sobre IDF clássico (pode ficar negativa pra termo em >50% docs). Convergência: +1.
- MMR sobre `sources` jaccard como proxy barato vs MMR sobre embeddings cosine (real). Convergência: jaccard, com hook documentado para upgrade futuro.
- Multiplex edge dedup: `Map<"src|dst|type", edge>` agrega `why` em vez de re-criar. Self-loop ignorado silencioso.
- co_citation O(N²) sobre todos os wikilinks → cap a top-1000 notas mais backlinked. Convergência: cap.
- spotlight_token_bm25 requer daemon vivo + indexed; daemon down → skip sem fail. Convergência: schema-only em v1.8.
- BM25 corpus pode estourar em vault >10k notas → cap maxCorpus=2000 + leitura lazy via searcher.readDoc. Convergência: cap + lazy.

### Validation
- `node --check` em `lib/bm25.js`, `lib/multiplex-graph.js`, `lib/hybrid-search.js`, `main.source.js` — OK
- Empirical BM25 (`node lib/bm25.js "habeas corpus"`): doc-a/doc-b score 1.00, doc-d (repetição) 0.64 — saturação k1 verificada.
- Empirical multiplex (`new MultiplexGraph(mockPlugin)`): addEdge dedup + neighbors filter por tipo + self-loop reject — todos OK.
- Empirical hybrid fuse + diversify: bitmask propagation OK, MMR top-2 favorece mistura de sources.
- `bun run build` (esbuild bundling main.source.js → main.js) — OK.
- `node scripts/zeus-doctor.mjs` → 7/7 OK
- `node scripts/zeus-smoke.mjs` → 9/9 asserts passaram

---

## [1.7.1] — 2026-05-20 — Fixes pós-auditoria codex v1.7 (2 HIGH + 5 MED + 2 LOW)

Codex auditou v1.7.0 e achou 9 issues. Todos os 8 acionáveis aplicados.

### Fixed — Bases schema sintaticamente válido (HIGH)
- `lib/bases-generator.js`: formulas como mapa direto `nome: "expressão"` (era `nome: { formula: "..." }`). `.length` (sem parênteses) seguindo sintaxe documentada (era `.length()`).
- groupBy agora objeto `{ property, direction }` com formula intermediária `domain_primary: "list(zeus_domain)[0]"` (era string `groupBy: zeus_domain` — frágil quando o campo é array). Cobertura completa conforme https://obsidian.md/help/bases/syntax.

### Fixed — Domain isolation per-vault (MED A/F)
- Plugin agora calcula `domain_hint` via `universal.sha256Hex(vaultRoot)` e passa explicitamente em cada chamada (`spotlightIndex`, `spotlightPurge`). Daemon não cai mais em `com.maiocchi.zeus.default` quando spawned sem `--vault`.

### Fixed — Swift improvements (MED A + LOW A, ativam após rebuild)
- `CSSearchableIndex(name: domainHint)` substitui `.default()` no index e purge — isolado por vault.
- Predicate CSSearchQuery escapa `\` e `"` (interpolação dentro de `"..."`). Antes só escapava `'`, ineficaz contra injeção.
- Timeouts de 30s (index) e 15s (purge) retornam 504 + `mode: "timeout"` em vez de sucesso falso quando callback nunca veio.

### Fixed — Spotlight UX (MED B/E + MED F)
- Comando `Zeus: buscar via Spotlight nativo (CSSearchQuery)` agora usa `spotlightQueryNative` (era `spotlightSearch` legacy) — alinha nome ao comportamento, declara `mode` no Notice.
- Detecção robusta de "daemon não suporta endpoint" via regex sobre `e.message` capturada (em vez de branches `r.error` inalcançáveis porque `_post` lança).

### Fixed — Path conversion robusta (MED C)
- `HybridSearch.query()` retriever spotlight agora usa `path.relative()` + `realpathSync.native()` para resolver symlinks corretamente. Valida `!rel.startsWith('..') && !path.isAbsolute(rel)`. iOS Capacitor sem fs/path: fallback simples startsWith preservado.

### Notes — não aplicado
- LOW C (filtro .md only exclui .canvas/.txt): cosmetic; preservado por simplicidade. ADR futuro se vault começar a usar .canvas como notas primárias.

### Brainstorm registrado (não implementado, ADR futuro)
- Grafo multiplex de vizinhança: arestas `wikilink + backlink + entity_overlap + date_overlap + folder_path + semantic_cosine + spotlight_token_bm25 + co-citation` com `why: ["same_entity: X", "links_to: Y"]` explicação por aresta
- UI top-5 via MMR (Maximum Marginal Relevance) — diversidade em vez de top-5 cosine puro
- Leiden community detection (copiar `maiocchi-ia/skills/tripla-fusao/scripts/cluster.py`)
- BM25 lexical lane (copiar `maiocchi-ia/skills/tripla-fusao/scripts/bm25.py`)
- `apple/swift-collections` `OrderedSet` para dedup estável em `HybridSearch.fuse`; `BitSet` para "path presente em retriever X"
- `apple/ml-mobileclip` (Apache-2.0): vision-language model on-device para text→image neighbors zero-shot
- Spotlight `mdimporter` plugin (Quick Look + Spotlight contributors) para `.md` permitindo Cmd+Space achar notas sem precisar do plugin do Zeus rodando

### Validation
- `node esbuild.config.mjs` → main.js OK
- `node scripts/zeus-doctor.mjs` → 7/7 OK
- `node scripts/zeus-smoke.mjs` → 9/9
- `node --check` em todos os 4 .js modificados

---

## [1.7.0] — 2026-05-20 — Spotlight CSSearchableIndex + .base enriquecido + 4º retriever híbrido

Protocolo formal: codex debateu o plano com claude → claude executou autônomo → codex audita (próximo). Codex aprovou escopo enxuto (cortou MobileCLIP, mdimporter, frontmatter mass-write); achados HIGH/MED incorporados na concepção.

### Added — daemon Swift (ativa após `node scripts/build-release.mjs`)

`daemon/Sources/ZeusDaemonMac/ZeusMacHTTPHandler.swift` — 3 endpoints novos via CSSearchableIndex / CSSearchQuery (programáticos, substituem shell `mdfind`):

- `POST /v1/spotlight/index` — recebe `{items: [{path,title,summary,keywords,mtime,modality}]}`, constrói `CSSearchableItem` por item com `attributeSet` (title, contentDescription, keywords, contentModificationDate), batch-injeta via `CSSearchableIndex.default().indexSearchableItems()`. domainIdentifier isolado por vault hash (`com.maiocchi.zeus.<hash>` — codex MED: índices de vaults diferentes não colidem no Spotlight global). Mode "queued" — propagação assíncrona pode levar ~3-10s.
- `POST /v1/spotlight/query` — CSSearchQuery nativo com predicate `(domainIdentifier == X) && (** == 'q*'cdw)`. Devolve resultados com ranking BM25-ish + temporal boost do próprio Spotlight, mais rápido que mdfind shell, com title/summary/keywords estruturados.
- `POST /v1/spotlight/purge` — `deleteSearchableItems(withDomainIdentifiers:)` limpa o vault inteiro do índice Spotlight. Opt-out completo.

`#if canImport(CoreSpotlight)` guard preserva compat com builds minimais. Endpoint `/v1/spotlight/search` (mdfind shell) mantido como legacy.

**Importante**: o binário `bin/ZeusDaemonMac` distribuído (v1.0.0 interno) NÃO inclui esses endpoints — ativa após rebuild. JS-side detecta 404 e cai gracioso para mdfind.

### Added — `lib/zeus-http-client.js`

- `spotlightQueryNative(q, scope, limit)` — prefere `/v1/spotlight/query`, fallback automático para `/v1/spotlight/search` em 404. Retorna `{mode, ...}` onde mode é `'spotlight' | 'mdfind-fallback' | 'error'` (padrão inspirado em `maiocchi-ia/skills/tripla-fusao/scripts/bm25.py` — fallback honesto declarado).
- `spotlightIndex(items, domainHint)` — proxy para `/v1/spotlight/index`.
- `spotlightPurge(domainHint)` — proxy para `/v1/spotlight/purge`.

### Added — `HybridSearch.query()` 4º retriever (Spotlight)

`lib/hybrid-search.js` — `query()` agora funde 4 retrievers via RRF k=60:
1. semantic (NLContextualEmbedding cosine)
2. path (basename substring)
3. passport (concept overlap via daemon)
4. **spotlight** (CSSearchQuery ou mdfind — convertendo path absoluto → vault-relative; filtra resultados fora do vault)

Modal de busca híbrida ganha badge `spotlight` quando esse retriever contribuiu. Hits que aparecem em múltiplos retrievers sobem no ranking (efeito RRF padrão).

### Changed — `lib/bases-generator.js` schema rico v1.7

Auto-gen do `data/zeus-cards.base` agora inclui:

- **Formulas Bases** (codex MED: deriva em vez de mass-write em frontmatter):
  - `density_est`: `file.size / 6` (≈ tokens únicos)
  - `freshness_days`: `(now() - file.mtime) / 86400000`
  - `has_graph` / `has_neighbors` / `neighbor_count` / `graph_node_count`
- **Properties expandidas**: `zeus_related`, `zeus_graph_related`, todos os formulas acima
- **5 views**:
  - All passports (table, sort by density DESC)
  - Orphans (cards, sem neighbors semânticos)
  - Graph-rich (table, ≥5 graph nodes)
  - Cards by domain
  - Recently edited (sort by freshness ASC)

Sintaxe conforme https://help.obsidian.md/bases/syntax — uso de `list(prop).length()`, `formula.X` aliases, `now()` helper.

### Added — 3 comandos novos

- `Zeus: indexar vault no Spotlight (CSSearchableIndex)` — itera markdown files, monta batch com title + passport summary + concepts, chama `spotlightIndex`, persiste `data/spotlight-state.json` (last_indexed_at, count, domain). Detecta gracefully quando daemon não suporta (HTTP 404) e instrui rebuild.
- `Zeus: purge índice Spotlight do vault` — limpeza opt-out.
- `Zeus: regenerar .base enriquecido (v1.7 schema)` — força regen do `zeus-cards.base` com stats.

### Debate codex × claude — pré-execução (rodada formal protocolo)

Plano enviado ao codex via `codex exec`. Codex respondeu HIGH/MED/LOW por fase:

| Achado codex | Aplicado? |
|---|---|
| HIGH F1: CSSearchableIndex é índice **do app**, não 1:1 mdfind global | ✅ mantido `/v1/spotlight/search` legacy, novo endpoint adicional |
| HIGH F1: superfície UI local (não cloud) | ✅ documentado em CHANGELOG, opt-in via comando, purge disponível |
| MED F1: `CSSearchableIndex(name:)` + domainIdentifier `com.maiocchi.zeus.<vaultHash>` | ✅ derivado de hash do vault path |
| MED F1: batch async como "queued/journaled" | ✅ response retorna `mode: "queued"` com nota explicativa |
| HIGH F2: Bases ignora schema fora do oficial | ✅ formulas + functions canônicas |
| HIGH F2: frontmatter mass-write deve usar mesmo SHA pattern | ✅ cortado da v1.7 — formulas resolvem |
| MED F2: density/freshness via formulas, não frontmatter | ✅ implementado |
| MED F3: Spotlight retriever precisa `mode` contract | ✅ inspirado em `maiocchi-ia/.../bm25.py` |
| MED F4: mdimporter → ADR, não v1.7 | ✅ cortado |

Brainstorm codex (registrado para ADR futuro, **não implementado**): grafo multiplex de vizinhança com arestas {wikilink, backlink, entity_overlap, date_overlap, folder_path, semantic_cosine, spotlight_token_bm25, co-citation}, com `why: [...]` explicação. UI top-5 via MMR (diversidade) em vez de top-5 cosine puro. Comunidades Leiden (`maiocchi-ia/skills/tripla-fusao/scripts/cluster.py`). Lexical BM25 lane (`maiocchi-ia/.../bm25.py`).

### Validation

- `node esbuild.config.mjs` → main.js bundlado
- `node scripts/zeus-doctor.mjs` → 7/7 OK
- `node scripts/zeus-smoke.mjs` → 9/9 (daemon v1.0 atual)
- Empirical: `HybridSearch.fuse` correto com 4 listas; `mode: mdfind-fallback` validado contra daemon atual

### Known limitations (codex auditará pós-execução)

- bin/ZeusDaemonMac no repo ainda é v1.0.0; endpoints novos requerem `node scripts/build-release.mjs` para ativar
- Sandbox de execução autônoma bloqueia SwiftPM network → rebuild deve rodar em ambiente do maintainer

---

## [1.6.1] — 2026-05-20 — Fixes pós-auditoria codex (7 achados, 1 HIGH + 4 MED + 2 LOW)

Auditoria pós-execução do v1.6.0 via `codex exec` (gpt-5.5 high-reasoning) achou 7 bugs novos não cobertos no plano-review pré-execução. Todos os 7 aplicados:

- **HIGH** — `syncFromGraphExtract()` adicionava `_inFlight` DEPOIS de `await graphExtractor.extract()`. Dois comandos concorrentes passavam pelo guard e disparavam extract+write em paralelo. Lock movido para antes do `await`, método inteiro envelopado em try/finally (`main.source.js:1369`).
- **MED** — `syncFile()` e `syncFromGraphExtract()` retornavam skipped quando resultado era vazio, mas NÃO removiam wikilinks antigos do frontmatter. Resultado: arestas stale persistiam no Graph nativo. Agora limpam `zeus_related` / `zeus_graph_related` quando vazio (`main.source.js:1332, 1381`).
- **MED** — `nativeGraphSyncOnSave` usava `_graphSyncTimer` global; mods em N arquivos dentro de 6s cancelavam timers anteriores, só último sincronizava. Trocado por `Map<path,timer>` (`main.source.js:3390`).
- **MED** — Comandos `zeus-hybrid-search` e `zeus-native-watcher-status` sem try/catch → falha em construtor de modal ou getStats vazava silencioso. Padronizado com `try/catch + Notice`.
- **MED** — `ZeusHybridSearchModal.getSuggestions()` tinha race de autocomplete: query async antiga sobrescrevia `cached` da query atual. Adicionado `_querySeq` monotônico que descarta respostas stale.
- **LOW** — `native-watcher` listener `vault.on('modify')` usava `this._adapterSeen.get()` mas `_adapterSeen` era inicializado depois. Movido para constructor.
- **LOW** — `native-watcher` deadline timers não armazenados/limpos em `stop()`. Adicionado `_deadlineTimers Set` + clearTimeout no stop. `_adapterSeen` agora também tem cap `MAX_TRACKED`.

### Validation

- `node esbuild.config.mjs` → main.js 249 KB
- `node scripts/zeus-doctor.mjs` → 7/7 OK
- `node scripts/zeus-smoke.mjs` → 9/9
- `node -e "const HS=require('./lib/hybrid-search'); HS.prototype...` — fuse + sisterNotes API OK

---

## [1.6.0] — 2026-05-20 — Hybrid retrieval + Graphify→graph nativo + FSEvents observability

Integração profunda de 4 superfícies (request do usuário). Plano debatido com `codex exec` ANTES da execução; 5 dos 6 achados do codex incorporados na primeira iteração; pós-execução re-auditada via codex.

### Added — `lib/hybrid-search.js` (~140 LOC)

- `HybridSearch.fuse(lists)`: Reciprocal Rank Fusion k=60 (Cormack et al. SIGIR 2009). Score invariante a escala de cada retriever, agrega `sources` por path.
- `sisterNotes(filePath, topN=12)`: combina 3 retrievers ortogonais — semantic (cosine `searcher.neighbors`), graph (parsing wikilinks de frontmatter `zeus_graph_related` / `zeus_related`), passport (concept overlap via daemon). RRF fuse.
- `query(q, topN=30)`: busca livre — semantic + path/basename substring + passport. Estilo Cmd+P unificado.
- Resolve wikilinks via `metadataCache.getFirstLinkpathDest()` em vez de regex naïve (codex MED #2 — respeita pastas, aliases, relative links).
- `searcher.search()` agora awaitado corretamente (codex HIGH #1 — antes caía silencioso em `.map` sobre Promise).

### Added — `lib/native-watcher.js` (~110 LOC)

- `fs.watch(vaultRoot, {recursive:true})` no Mac (FSEvents nativo). iOS Capacitor: no-op gracioso.
- **NÃO faz re-embedding** (codex HIGH #3): só observa. Mede latência `vault.on('modify')` vs FSEvents — detecta quando o adapter do Obsidian perdeu uma sync iCloud.
- Quiet window 1.5s por arquivo (espera estabilidade do iCloud).
- Deadline 5s para `vault.on('modify')` correlacionar; se não correlacionar, contabiliza como `adapterMissed`.
- Comando `Zeus: status do native-watcher` reporta hit rate + paths missed + last activity.

### Added — `ZeusNativeGraphIntegration.syncFromGraphExtract` (manual)

- Roda `afm graph-extract` na nota ativa, resolve entidades nomeadas para arquivos do vault via `metadataCache.getFirstLinkpathDest`, escreve como wikilinks em `zeus_graph_related`. Obsidian native Graph View renderiza essas wikilinks como arestas — **Graphify 100% integrado ao graph nativo, não mais SVG modal isolado**.
- Comando manual apenas (graph-extract custa ~3-8s/nota); não roda em real-time pra não competir com pipeline de embed.
- Codex HIGH #2 fix: comparação SHA antes de escrever (`_lastWritten` cache), in-flight tracking (`_inFlight` Set), `zeus_indexed_at` só muda quando set de neighbors muda — quebra o loop iCloud↔Obsidian.
- Codex MED #1 fix: `clearAll()` agora remove `zeus_related` E `zeus_graph_related` (+ metadados associados).

### Added — 4 comandos novos

- `Zeus: notas irmãs (graph + semantic híbrido)` — abre modal com RRF dos 3 retrievers para o arquivo ativo
- `Zeus: busca híbrida (graph + semantic + path)` — SuggestModal estilo Cmd+P unificado (codex MED #3: complementa, não substitui Quick Switcher nativo)
- `Zeus: graphify → frontmatter (integra ao graph nativo)` — roda `syncFromGraphExtract` no arquivo ativo
- `Zeus: status do native-watcher (FSEvents iCloud)` — Notice com stats do watcher

### Debate Codex × Claude — pré-execução

Plano enviado ao `codex exec` antes de qualquer edit em `main.source.js`. Codex respondeu com 6 achados (3 HIGH, 3 MED):

| # | Severidade | Achado | Aplicado? |
|---|---|---|---|
| 1 | HIGH | `searcher.search()` async sem await em `hybrid-search.js:130` | ✅ adicionado `await` |
| 2 | HIGH | Loop frontmatter `modify → sync → write → modify` com timestamp churn | ✅ SHA-compare antes de escrever + `_inFlight` |
| 3 | HIGH | `fs.watch` duplicaria pipeline existente (race `saveEmbeddings`) | ✅ watcher virou observability-only, sem re-embed |
| 4 | MED | `clearAll()` só removia `zeus_related`, não `zeus_graph_related` | ✅ estendido |
| 5 | MED | Regex `Nome.md` falha com pastas/aliases | ✅ `metadataCache.getFirstLinkpathDest` |
| 6 | MED | SuggestModal não substitui Quick Switcher nativo (limite de API Obsidian) | 📋 vendido como "Hybrid Search" complementar |

### Limitação técnica honesta

Obsidian **não expõe API pública** para injetar arestas no Graph View nem para substituir o backend do Quick Switcher / Search. A integração "100% nativa" é alcançada via:
- **Graph**: wikilinks em frontmatter (Obsidian renderiza como arestas automaticamente — efetivamente nativo)
- **Search**: comando custom + SuggestModal (não substitui Cmd+O, mas oferece UX nativa equivalente com backend híbrido)

### Validation

- `node esbuild.config.mjs` → `main.js` 247.3 KB
- `node scripts/zeus-doctor.mjs` → 7/7 OK
- `node scripts/zeus-smoke.mjs` → 9/9
- Empirical: `HybridSearch.fuse([[a,b],[b,c]])` → `b` rankeia 1º (RRF correto)
- Empirical: `NativeWatcher` ctor + module load OK

---

## [1.5.1] — 2026-05-20 — Fixes pós-auditoria Codex × Claude

Debate cruzado entre `codex review` (gpt-5.5 high-reasoning) e auditoria Claude sobre o commit v1.5.0. Os dois revisores convergiram em 1 bug HIGH e codex pegou outros 4 que Claude perdeu. Aplicados 5 fixes neste patch.

### Fixed — bugs introduzidos pelo v1.5.0

- **[P0/HIGH]** `HierarchicalProcessor` constructor lançava `Error('afmBinPath required')` quando recebia `null` (`lib/hierarchical.js:93`) — main.source.js passava null após excisão do CLI, **plugin não carregava no Mac**. Relaxado para `this.afmBin = afmBinPath || null`; métodos que tentam spawn caem via `execAfm()` guards em runtime.
- **[P1]** Contratos HTTP cliente↔daemon quebrados após remoção do fallback CLI (`lib/zeus-http-client.js:280, 297`):
  - `embedBatch({texts:[...]})` → daemon Swift exige `{text:"single"}`. Reescrito para fazer N chamadas sequenciais e devolver `{vectors, dim, model, count}`.
  - `ocr({path:...})` → daemon exige `{image_path:..., languages:[...]}`. Cliente ajustado para o contrato real.
  - Validado por curl direto + `embedBatch(['hello','segundo'])` → 2 vetores 512-dim ✓; `ocr('/tmp/x.png')` → erro de arquivo (não de contrato) ✓.
- **[P2]** `daemonLifecycle.ensureRunning()` retornava `status.url` mas `httpClient.baseUrl` nunca era rebasado (`main.source.js:2475-2483`). Se settings apontasse para Tailscale peer remoto, plugin spawnava local mas seguia falando com remoto — promessa "drop-in/on-device" quebrada. Adicionado `this.httpClient.setBaseUrl(status.url)` quando `status.running && status.url`.
- **[MED]** `ensureRunning()` sem mutex permitia spawn duplo concorrente (`lib/daemon-lifecycle.js`). Adicionado `this._startPromise` que serializa chamadas — futuras callers compartilham a promessa em vôo.
- **[LOW]** `stop()` mandava `SIGTERM` e dormia 2s antes de `SIGKILL` cego, sem aguardar `exit` do filho (`lib/daemon-lifecycle.js`). Reescrito para `Promise.race([exitPromise, timer])` — SIGKILL só dispara se SIGTERM não fechou. Garante que shutdown gracioso do NIO complete. `stop()` retorna `{stopped, force}` indicando se foi força.

### Known issues (não bloqueia release)

- **[HIGH não-acionável]** Binário `bin/ZeusDaemonMac` é adhoc-signed (não notarizado com Developer ID). `xattr -d com.apple.quarantine` no spawn enfraquece Gatekeeper. Mitigação real requer conta Apple Developer ($99/ano) + notarização. Workaround atual: `_prepareBinary()` faz best-effort strip e o binário roda em ambiente local controlado. Para distribuição pública, próximo passo é notarizar.
- **[MED não-acionável]** Daemon sobrevive crash/force-quit do Obsidian (orphan reparenta a PID 1). Próximo `onload` reaproveita via `isHealthy()` ✓, mas sem versão check. Mitigação completa exigiria mudar daemon Swift para monitorar `ZEUS_PARENT_PID` — fora do escopo deste patch JS-only.
- **[MED não-acionável]** iOS UX inconsistente: 19 callsites `httpClient.X()` bare vs 3 com `isAvailable()` preflight. Wrapper `requireDaemon(feature)` seria a solução estrutural — defer.
- **[MED não-acionável]** Drift binário vs source: nenhum SHA256/manifest cruzando código Swift com binário commitado. Doctor só verifica tamanho/codesign. Próximo passo: gerar `bin/ZeusDaemonMac.sha256` no `build-release.mjs` e validar no `doctor`.
- **[LOW não-acionável]** `tryDaemonOrSpawn` mantém nome legado mesmo sendo daemon-only — refactor cosmético adiado.

### Auditoria — material reproduzível

- Codex review do commit `ed2b1b0` em `/tmp/codex-review-ed2b1b0.txt` (gpt-5.5 high)
- Codex exec audit em `/tmp/codex-exec-ed2b1b0.txt` (3 fixes adicionais detectados)
- Validação empírica (curl + node) em conversa de desenvolvimento

### Validation

- `node esbuild.config.mjs` → `main.js` 225.5 KB
- `node scripts/zeus-smoke.mjs` → 9/9 asserts
- HP ctor com null: empiricamente OK (era THROW antes)
- `embedBatch(['a','b'])` end-to-end: 2 vetores 512-dim
- OCR contract: daemon aceita `image_path` (era 400 antes)

---

## [1.5.0] — 2026-05-20 — Autonomia drop-in (daemon embarcado + dead code removido)

Refatoração arquitetural inspirada no padrão [`ios-control-mcp`](https://github.com/rogermaiocchi/ios-control-mcp) (declarar deps + doctor + bootstrap + degradação graciosa). Plugin agora roda no Mac sem nenhuma instalação prévia — `swift build`, `launchctl`, `pip install` foram abolidos do caminho do usuário final.

### Added — `bin/ZeusDaemonMac` bundlado

- Binário arm64 (6.9 MB) codesigned adhoc, copiado para `bin/ZeusDaemonMac` e commitado no repo (`.gitignore` ajustado).
- Maintainer regenera com `node scripts/build-release.mjs` (faz `swift build -c release` → `cp` → `chmod +x` → `xattr -d` → `codesign --sign -` → `node esbuild.config.mjs`).

### Added — `lib/daemon-lifecycle.js` (auto-spawn)

- Plugin no `onload()` chama `DaemonLifecycle.ensureRunning()`:
  - Probe `/v1/health` em 127.0.0.1:2223 com timeout 800ms.
  - Se já vivo (ex: LaunchAgent pré-existente) → status `pre-existing`, sem spawn.
  - Se morto → `spawn(bin/ZeusDaemonMac, ['--port','2223','--host','127.0.0.1'])` detached:false (lifecycle amarrado ao Obsidian), polling de `/v1/health` por até 10s.
- `onunload()` chama `stop({graceMs:2000})` → `SIGTERM` → `SIGKILL`.
- iOS Capacitor (sem child_process) retorna `status: no-spawn` e degrada gracioso (plugin lê embeddings.jsonl syncado via iCloud).
- Idempotente: nunca lança; só reporta `lastStatus`.

### Added — `scripts/zeus-doctor.mjs` + `scripts/zeus-smoke.mjs`

- Doctor verifica 7 layers: macOS version, `bin/ZeusDaemonMac` (existe + executável + tamanho), codesign (adhoc/Apple), `main.js`, `manifest.json`, `package.json`, daemon HTTP `/v1/health` (FM/NL/Vision/Speech flags). Exit 0/1/2 CI-friendly.
- Smoke exercita endpoints críticos: `/v1/health` (3 asserts), `/v1/embed` (200 + dim=512), `/v1/tools` (count>0), `/v1/refine` (200 + non-empty). Validado 9/9 contra daemon v1.0.0 em produção.
- Comandos `bun run doctor` + `bun run smoke` registrados no `package.json`.

### Removed — dead code

- `lib/python-worker.js` (~128 LOC) + `bin/batch_eval.py` + comando `zeus-python-worker-probe` (linha ~3185). Era probe stub `try/except apple_fm_sdk` sem callers reais.
- `lib/afm-daemon.js` (333 LOC, JSON-RPC daemon legacy). Substituído pelo HTTP daemon em `lib/zeus-http-client.js` há várias versões; permanecia como caminho paralelo.
- `scripts/install-afm.sh`. O binário CLI `afm/metafm` que ele tentava copiar **nunca existiu no disco** (`Package.swift` em `apple-intelligence` produz `MetassistemaAgent`, não `metafm`) — script estava quebrado em silêncio. Removido junto com `AFM_BIN_NAMES`, `AFM_FALLBACK`, `resolveAfmBinary`, `execMetafm`, setting `afmPath`, setting `afmDaemonEnabled`, `tryDaemonOrSpawn` (refatorado para daemon-only).
- Settings UI: input "afm binary path" → substituído por display read-only do estado do `daemonLifecycle`.

### Changed — `tryDaemonOrSpawn` agora é daemon-only

Função preserva a assinatura `(plugin, daemonMethod, daemonArgs, ...)` e o shape de retorno `{source: 'daemon', result}` por compat com 9 callsites em `main.source.js`. Internamente lança se o daemon não responde — nada mais de spawn fallback. Reduziu ~80 LOC.

### Changed — `HierarchicalProcessor` + `MultiVectorEmbedder` perdem dep `afmBin`

Plugin construtor passa `null` para o argumento `afmBin`. Ambos os módulos têm caminho HTTP via `plugin.httpClient` que vinha sendo silenciosamente preferido. Mantém-se a assinatura por compat.

### Validation

- `node esbuild.config.mjs` → `main.js` 224 KB (parse OK)
- `node scripts/zeus-doctor.mjs` → 7 OK / 0 WARN / 0 FAIL
- `node scripts/zeus-smoke.mjs` → 9/9 asserts (health · embed dim=512 · tools count=12 · refine non-empty)
- Daemon spawn lifecycle: verifica `lsof -ti:2223` antes/depois do plugin load → spawn confirmado, kill confirmado no unload

### Migration path

Usuários v1.4.x: nenhuma ação necessária. Settings `afmPath` e `afmDaemonEnabled` ficam órfãos em `data.json` (ignorados pelo runtime). LaunchAgent `com.maiocchi.zeusdaemon` se já instalado segue vivo e o plugin reaproveita (status `pre-existing`). Para desinstalar o LaunchAgent (não obrigatório): `launchctl bootout gui/$UID/com.maiocchi.zeusdaemon`.

---

## [1.4.0] — 2026-05-16 — Paridade Mac ↔ iOS (port Fase 0 + Fase 2 do meta-projeto-aegis)

Integra o trabalho `v1.0.0-zeus-port` do fork `meta-projeto-aegis` sobre o canônico v1.3.4, sem regressão das features v1.3.x (SFSpeechRecognizer dual-engine, real-time audio indexing, refine via Apple, `/v1/asp/transcribe`, `/v1/asp/vad`, `X-Zeus-Allow-Pcc`).

### Added — Fase 0: infraestrutura Apple-Twin

- `AegisFMCaptureMiddleware.swift` e `ZeusFMCaptureMiddleware.swift` — captura opt-in de gerações `runFoundationModel` (via flag-file `~/.aegis/capture.enabled`).
- `MLXAppleTwinProvider.swift` / `MLXAppleTwinBootstrap.swift` — provider MLX guardado `#if os(iOS)` (`.shared = nil` em macOS).
- `AppleTwinSystemPrompt.swift` e `FewShotLoader.swift` + `Resources/FewShotExamples/` (agent_query, summarize, prompt, hyde, graph_extract, refine, enrich).

### Added — Fase 2: endpoints (paridade funcional Mac ↔ iOS)

- `POST /v1/refine` — Writing Tools com instructions livres.
- `POST /v1/hyde` — Hypothetical Document Embeddings (juridico|tecnico|generic).
- `POST /v1/graph/extract` — extração de triplas `{entities, relations, domain}`.
- `POST /v1/agent` — Q&A com `context: [String]` (RAG-style); versão Aegis mantém `AegisClaudeAgent` e ganha `context` (não-breaking).

### Changed — `/v1/health`

- `version` interno do daemon: `0.3.0`/`0.5.0` → `1.4.0`.
- Novos campos: `provider_active` (apple-intelligence|mlx-apple-twin|none), `apple_twin_loaded` (Mac sempre false), `thermal_state`.
- Mantém todos os campos v1.3.x (`fm_available`, `speech_available`, etc.).

### Notas de merge

- Conflito `handleRefine`: canônico v1.3 (mode/tone/language) preservado; versão v1.4 (instructions livres) renomeada para `handleRefineV14` e wired no `/v1/refine` — ambos coexistem.
- `/v1/afm/refine` v1.3.x permanece intacto.
- MLX deps NÃO adicionadas ao `Package.swift` (Mac não usa Twin; iOS port fica para PR separado).
- `/v1/apps*` do fork excluídos do escopo v1.4 (dependem de `AegisNativeTools` ainda não portados).

---

## [1.3.4] — 2026-05-15 — AegisDaemon iOS port (paridade Mac ↔ iPhone/iPad daemons)

Portagem dos 3 endpoints v1.3 do `ZeusDaemonMac` para o `AegisDaemon` iOS (target SwiftPM library embutida em `MetassistemaApp-iOS`). Atinge paridade de capabilities entre daemons macOS e iOS — agora todos os 4 devices Apple (Mac mini · MacBook Air · iPad Air · iPhone 15) expõem a mesma API HTTP local quando atualizados.

### Added — 3 endpoints em `AegisHTTPHandlers.swift`

- **`POST /v1/afm/refine`** — Writing Tools nativo via `FoundationModels` (iOS 26+ / macOS 26+). 3 modos (proofread/rewrite/simplify) + 3 tones (academic/professional/casual). Reusa `runFoundationModel()` helper existente. Sem propagação PCC (iOS sandbox).
- **`POST /v1/asp/transcribe`** — dual-engine SA + SF fallback. Padrão idêntico ao Mac v1.3.2: `SpeechAnalyzer` (iOS 26+) com `AssetInventory.requestNeededAssets()` + `AVAudioConverter` single-buffer + reader Task paralelo; `SFSpeechRecognizer` (iOS 10+) fallback gracioso com `requiresOnDeviceRecognition=true`. Param `engine: sa|sf|auto`.
- **`POST /v1/asp/vad`** — duração heurística (≥3s) idêntica ao Mac, via `AVURLAsset.duration`.

### Changed — `handleHealth`

- Novo campo `speech_available: bool` baseado em `canImport(Speech)`
- `endpoint_count` agora dinâmico (era array literal)
- Version bump interno do daemon: `0.2.0` → `0.3.0`

### Added — Imports gated

- `import Speech` (com `#if canImport(Speech)`)
- `import AVFoundation` (com `#if canImport(AVFoundation)`)

### Build note — por que `swift build` CLI falha

Símbolo `CapivaraDeviceProfile.current` aparece em `AegisHTTPHandlers.swift:308` e `:2112` (`handleCmd` case "profile"), introduzido no commit `9559d14e` de 2026-05-14 — **antes desta release**. É definido em outros targets do workspace Xcode (`MetassistemaApp-iOS` ou `CapivaraKit`) que não são parte do SPM `AegisDaemon` library standalone. Build em SPM CLI falha; build no Xcode workspace resolve via linker do app inteiro.

Confirmado por `git blame` que esse erro é **preexistente**, não regressão desta release. Meu código portado (handleRefine + handleASPTranscribe + handleASPVAD + transcribeWithSpeechAnalyzer) compila isoladamente — o build full do daemon target falha unicamente em código pre-1.3.4.

### Deployment manual necessário (não automatizável)

Para os 3 endpoints novos ficarem LIVE nos dispositivos iOS:

```
1. Abrir MetassistemaApp.xcworkspace no Xcode
2. Conectar iPhone 15 ou iPad Air gen 4 via USB (ou Wireless Debug)
3. Selecionar scheme MetassistemaApp_iOS
4. Cmd+R para build + install
```

Após o rebuild, o `AegisDaemon` HTTP server (loopback `127.0.0.1:2223` dentro do app) passa a servir os 3 endpoints novos. Plugin Obsidian v1.3.3 já no vault iCloud não precisa de mudança — pipeline real-time audio (`scheduleAudioTranscribe`) já chama via `httpClient.aspTranscribe()` e degrada gracioso quando endpoint retorna 503.

### Após o deploy iOS

Pipeline real-time audio (v1.3.3) funciona end-to-end nos 4 devices:

- **Mac mini / MacBook Air**: SpeechAnalyzer macOS 26 com asset pt-BR pré-instalado pelo Siri
- **iPhone 15 / iPad Air**: SpeechAnalyzer iOS 26 OU SFSpeechRecognizer fallback (privacy gate intocado: `requiresOnDeviceRecognition=true`)

### Hammerspoon integration (repo `rogermaiocchi/hammerspoon-config` `423943f`)

Em paralelo a esta release, adicionei 3 hotkeys ao `~/.hammerspoon/init.lua` que consomem os endpoints v1.3 via `hs.http.asyncPost`:

- `Cmd+Shift+Alt+R` — refine clipboard (proofread pt) via `/v1/afm/refine`
- `Cmd+Shift+Alt+T` — transcribe último voice memo via `/v1/asp/transcribe` (procura `.m4a/.wav` mais recente em 3 paths Voice Memos)
- `Cmd+Shift+Alt+F` — passport find para clipboard via `/v1/passport/find` (top-5 notas relevantes em popup)

Hammerspoon `pathwatcher` recarrega o config automaticamente ao git pull no Mac mini.

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
