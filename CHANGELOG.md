# Changelog — Zeus Obsidian Plugin

Todas as mudanças notáveis deste projeto. Formato derivado de [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versionamento segue [SemVer](https://semver.org/lang/pt-BR/).

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
