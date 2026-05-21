---
tipo: auditoria
criado: 2026-05-21
atualizado: 2026-05-21
status: ativo
escopo: zeus-obsidian-plugin · Fase 1 (estrutural)
---

# Auditoria Zeus — Fase 1: Estrutural

> [!info] Premissa do plano corrigida
> O briefing assumia **v1.4.0 em prod / fix 1.4.2-ios não backportado**. A realidade verificada é outra: **canônico, origin/main e plugin instalado em prod estão todos em v1.13.2**. O canônico está em sincronia perfeita com o GitHub (zero commits ahead/behind). O "fix da linha 141 (require path)" foi absorvido há muitas versões. A única cópia antiga é o backup no Google Drive (v1.4.0).

## S1 — Estado git + divergência canônico

| Item | Estado |
|---|---|
| Branch atual (worktree) | `claude/gifted-poitras-209e91` |
| `git log HEAD..origin/main` | **vazio** (nada a puxar) |
| `git log origin/main..HEAD` | **vazio** (nada a empurrar) |
| Veredito | worktree == `origin/main` == **v1.13.2**, em sincronia total |
| Remote | `https://github.com/rogermaiocchi/zeus-obsidian-plugin.git` |

**Tags (local e remoto idênticos):** `v0.13.2 → v1.0.0 → … → v1.3.4 → v1.4.0`. **Pararam em v1.4.0.**

> [!warning] Disciplina de tagging interrompida
> As versões v1.5 a v1.13.2 existem como commits e bumps de `manifest.json`/`CHANGELOG.md`, mas **nenhuma foi tagueada** (nem local, nem no GitHub). 9+ releases sem tag git → impossível `git checkout v1.10.0`, releases não rastreáveis por tag.

**Branches remotos órfãos (limpar):**
- `origin/feature/v1.3-refine-asp` — era v1.3, obsoleto
- `origin/claude/change-to-public-qHMWg` — branch de automação antiga

## S2 — Inventário de código

| Linguagem | Categoria | Arquivos | Linhas |
|---|---|---|---|
| JavaScript | `main.js` (bundle esbuild — gerado) | 1 | 9.654 |
| JavaScript | `main.source.js` (entry pré-bundle) | 1 | 4.807 |
| JavaScript | `lib/` (módulos escritos à mão) | 20 | 6.786 |
| JavaScript (ESM) | `scripts/` (tooling de build) | 5 | 696 |
| Swift | `daemon/Sources/` | 10 | 7.184 |
| **TypeScript** | — | **0** | **0** |

> [!note] Zero TypeScript
> Apesar de ser plugin Obsidian (convenção = TS), **todo o fonte é JavaScript puro**. Contraria `typescript.md` (stack canônica). Sem `tsconfig`, sem checagem de tipos.

**`lib/` (20 módulos, destaques):**
- `zeus-http-client.js` (594) — cliente HTTP do daemon Swift (`127.0.0.1:2223`); envolve todos os endpoints.
- `leiden.js` (616) — detecção de comunidades (Louvain-com-conectividade), JS puro.
- `passport-index.js` (495) — Passport Index Architecture (NLTagger + FM → `passports.jsonl`).
- `multiplex-graph.js` (467) — grafo multiplex 8 tipos de aresta com campos `why` (XAI).
- `hybrid-search.js` (445) — fusão RRF 7-way.
- `universal-fs.js` (292) — abstração de plataforma (Node fs/path em try/catch → fallback `vault.adapter` no iOS).
- `daemon-lifecycle.js` (188) — auto-spawn/monitor do `bin/ZeusDaemonMac` no Mac.

**`daemon/Sources/` (Swift, pacote `ProjetoAegis`, swift-tools 5.9, deps: swift-nio):**
- `ZeusDaemonMac/` (executável → `bin/ZeusDaemonMac`, 7 MB arm64): `main.swift` (133), **`ZeusMacHTTPHandler.swift` (3.455 — monolítico)**, `ZeusFMCaptureMiddleware.swift` (68).
- `AegisDaemon/` (lib iOS): **`AegisHTTPHandlers.swift` (2.733 — monolítico)**, `MLXAppleTwinProvider.swift` (309), `MLXAppleTwinBootstrap.swift` (136), `FewShotLoader.swift` (179), `AppleTwinSystemPrompt.swift` (40), `AegisHTTPServer.swift` (53), `AegisFMCaptureMiddleware.swift` (78).

> [!warning] Dois handlers monolíticos
> `ZeusMacHTTPHandler.swift` (3.455) + `AegisHTTPHandlers.swift` (2.733) = ~86% das linhas Swift, com **forte duplicação Mac↔iOS**. Binário `bin/ZeusDaemonMac` é commitado pré-compilado, sem CI de build Swift visível.

**ADRs em `docs/`:** ADR-006 a ADR-011 (Spotlight, QuickLook, Leiden, MobileCLIP, iOS-Spotlight-bridge). Specs pendentes: `2026-05-16-camada-gemma4-design.md`, `2026-05-16-daemon-token-auth-design.md` (este último **não implementado** — ver Fase 2/3).

## S3 — Canônico vs prod instalado

| Arquivo | SHA canônico | SHA prod | Match | Ação |
|---|---|---|---|---|
| `manifest.json` | f80f6d2 | f80f6d2 | ✅ | — |
| `styles.css` | a8868f0 | a8868f0 | ✅ | — |
| `bin/ZeusDaemonMac` | 61e0f3a | 61e0f3a | ✅ | — |
| `main.js` | efd68c9 | 06a0f1b | ❌ | **DEPLOY canônico→prod** |
| `data.json` | b562185 | f265905 | ❌ | benigno (config runtime per-vault) |

> [!danger] Prod está ATRÁS do canônico (não na frente)
> O `main.js` em prod é ~2,8 KB menor / 56 linhas mais curto = um build **pré-v1.13.2**. Falta em prod o que o canônico já tem:
> - **Privacy gate** (`_assertRawContentAllowed`, `_isPrivatePath`, `_isLoopbackBaseUrl`).
> - **Timeout via AbortSignal** (`Promise.race` + `ctrl.signal`).
> - **`allowRemoteDaemonFallback` default `false`** no canônico — em prod o default é **`true`** (prod está mais exposto).
>
> O briefing pedia "backportar fix da linha 141 prod→canônico". Isso é **obsoleto e invertido**: nada do prod precisa subir; o canônico é que precisa ser **deployado** para prod. Artefatos órfãos em prod (`main.js.backup-pre-ios-fix`, `main.js.pre-bundle.bak`) são lixo de hotfix antigo — remover.

## S4 — Backup Google Drive

| Item | Valor |
|---|---|
| Caminho | `…/GoogleDrive-roger@maiocchi.org/Meu Drive/Backups/Desenvolvimento/Zeus-obsidian/` |
| Versão | **v1.4.0** (manifest) |
| `main.js` | 151 KB / 17 May 2026 (vs 407 KB canônico) |
| Tipo | clone git completo, congelado em 17/05 |
| Veredito | **snapshot antigo, inofensivo** — anterior à linha v1.10–v1.13 |

> [!warning] Risco latente do backup
> O backup NÃO é divergência a reconciliar — é só velho. Mas se alguém restaurar dele por engano, **perde toda a linha v1.5–v1.13.2** (privacy gate, iOS two-tier, CoreSpotlight, etc.). Recomenda-se atualizá-lo ou marcá-lo como arquivo histórico.

## Snapshot consolidado

- **3 cópias "vivas" convergem em v1.13.2**; só o `main.js` de prod está num build mais antigo (deploy pendente).
- **Backup GDrive** = v1.4.0 histórico.
- **Dívidas estruturais:** sem tags desde v1.4.0; 2 branches órfãos; zero TypeScript; binário Swift commitado sem CI; 2 handlers Swift monolíticos com duplicação Mac↔iOS.
