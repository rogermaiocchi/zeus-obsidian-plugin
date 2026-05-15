# Changelog — Zeus Obsidian Plugin

Todas as mudanças notáveis deste projeto. Formato derivado de [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/); versionamento segue [SemVer](https://semver.org/lang/pt-BR/).

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
