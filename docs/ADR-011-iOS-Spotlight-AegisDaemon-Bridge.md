---
tipo: adr
adr_id: ADR-011
criado: 2026-05-20
atualizado: 2026-05-20
status: ativo
versao_plugin_referencia: v1.13.0
---

# ADR-011 — iOS CoreSpotlight via AegisDaemon embarcado no app host

## Contexto

Codex audit v1.10.4 e debate v1.11 confirmaram que **CSSearchableIndex iOS exige
Swift API nativa**. Capacitor JS standalone NÃO acessa Core Spotlight diretamente.
A camada `spotlight-state.json` ficou `❌ skip gracioso` em iOS por todas as
releases v1.7–v1.12.

User pediu "Resolva ❌ skip (sem Swift bridge)".

## Decisão

Adicionar handlers `/v1/spotlight/{index,query,purge}` no `AegisDaemon` (library
SwiftPM em `daemon/Sources/AegisDaemon/`) embarcado pelo app host iOS
(`MetassistemaApp-iOS` OR `Capivara` — escolha do maintainer).

**Arquitetura**:

```
iOS Plugin Capacitor (Obsidian iOS, plugin Zeus)
   │
   │  HTTP POST 127.0.0.1:2223/v1/spotlight/index
   │      body: {items: [...], domain_hint: "com.maiocchi.zeus.<vault-hash>"}
   ▼
AegisDaemon HTTP Server (embarcado no app host iOS Swift)
   │  Bound to 127.0.0.1:2223 via NIO HTTP/1.1
   │
   ▼
CSSearchableIndex(name: domainHint).indexSearchableItems(items)
   │  iOS CoreSpotlight framework nativo
   │
   ▼
Spotlight do iOS (search system-wide)
   - Cmd+Space (Mac) ou home-screen swipe-down (iOS)
   - acha notas Zeus do vault por title/keywords/summary
   - tap → URL scheme abre Obsidian na nota
```

## Implementação v1.13.0

### Swift (`daemon/Sources/AegisDaemon/AegisHTTPHandlers.swift`)

3 handlers novos copiados do `ZeusMacHTTPHandler` (mesma assinatura/payload):

- `handleSpotlightIndex` — `CSSearchableIndex(name: domainHint).indexSearchableItems`
- `handleSpotlightQueryNative` — `CSSearchQuery` com predicate `domainIdentifier`
- `handleSpotlightPurge` — `deleteSearchableItems(withDomainIdentifiers:)`

Imports: `#if canImport(CoreSpotlight)` (sempre true em iOS 9+).

Compilação: `swift build -c debug --target AegisDaemon` em `daemon/`. Library
SwiftPM linkada no Xcode workspace do app host.

### JS Plugin (sem mudança)

Plugin v1.7+ já tem `httpClient.spotlightIndex/QueryNative/Purge`. Quando rodando
em iOS com AegisDaemon embarcado no app host (loopback 127.0.0.1:2223), chamadas
funcionam de modo idêntico ao Mac.

`discoverDaemonUrl()` em `main.source.js` já tenta loopback primeiro — quando
AegisDaemon iOS está vivo, é detectado automaticamente.

## Contrato app host

**App host (Capivara OR MetassistemaApp-iOS)** precisa:

1. Embarcar `daemon/Sources/AegisDaemon/` como Swift Package dependency (já
   declarado em `daemon/Package.swift` como `library AegisDaemon`)
2. No `AppDelegate.swift` ou equivalente, inicializar `AegisHTTPServer`:
   ```swift
   import AegisDaemon
   let server = AegisHTTPServer(port: 2223, host: "127.0.0.1")
   try await server.start()
   ```
3. Entitlements (nenhum especial necessário — CSSearchableIndex é app-right
   default; CoreSpotlight framework auto-linkado quando `import CoreSpotlight`)
4. `Info.plist` declarando local HTTP service em `NSLocalNetworkUsageDescription`
   (iOS 14+)

## Consequências

**Quando app host embarca AegisDaemon**:
- iOS Spotlight system-wide acha notas Zeus por title/keywords/summary
- Mesmo domain isolation per-vault (hash) que Mac
- Plugin JS não muda — usa mesmos endpoints

**Quando app host NÃO embarca AegisDaemon** (default Obsidian iOS standalone):
- `EmbedRelay.tryEmbed(text)` retorna `daemon-unreachable` para `127.0.0.1:2223`
- Spotlight skipa gracioso
- Plugin continua funcional com camadas JS puras (multiplex/leiden/bm25/lexical-ios)

## Alternativas rejeitadas

- **Custom Capacitor plugin Swift**: exige modificar Obsidian app source — fora do controle do plugin
- **mdimporter iOS**: legacy Carbon, não disponível iOS
- **Apple Shortcuts URL scheme**: depende user configurar Shortcut, friction alta
- **transformers.js search**: não substitui Spotlight system-wide (só busca dentro do plugin)

## Métricas de sucesso

- Latência index: `<200ms` por batch 50 items (NIO HTTP local)
- Latência query: `<100ms` (CSSearchQuery iOS nativo)
- Cobertura: 100% das notas com passport extraídas → spotlight indexed
- System-wide reach: nota Zeus aparece em Spotlight do iOS junto com Mail/Notes/etc

## Pós-deploy (maintainer side)

1. Maintainer compila app host com AegisDaemon Swift Package
2. Deploy via TestFlight ou Developer Mode (xcode-select install profile)
3. Em primeiro launch, app host inicia AegisHTTPServer em 127.0.0.1:2223
4. Plugin Zeus em Obsidian iOS detecta loopback live → todos endpoints funcionais
5. Spotlight injection roda via AutoIndexer (15s debounce existente)
