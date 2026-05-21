---
tipo: auditoria
criado: 2026-05-21
atualizado: 2026-05-21
status: ativo
escopo: zeus-obsidian-plugin · Fase 3 (conformidade)
---

# Auditoria Zeus — Fase 3: Conformidade

## S6 — Conformidade Obsidian (community store)

### Manifest

| Regra | Status | Nota |
|---|---|---|
| `id` lowercase/kebab | ✅ PASS | `"zeus"` |
| Nome sem "Obsidian" | ✅ PASS | `"Zeus — Apple-native Search & Connections"` |
| Descrição ≤ 250 chars | ❌ **FAIL** | **891 chars** (3,5× o limite) |
| Descrição em inglês | ❌ **FAIL** | está em português |
| Descrição sem chars especiais/emoji | ❌ **FAIL** | contém `·` (U+00B7), `⊕` (U+2295), acentos |
| Campos obrigatórios presentes | ✅ PASS | id, name, version, minAppVersion, description, author |
| `minAppVersion` válido | ✅ PASS | `1.5.0` |
| `isDesktopOnly` correto | ⚠️ WARN | `false`, mas usa APIs Node (fs/path/os/crypto/child_process) — reviewer pode questionar |

### Violações de código

| Sev | Categoria | Local | Problema |
|---|---|---|---|
| **HIGH** | Resource mgmt (proibido) | `main.source.js:4620-4621` | **`detachLeavesOfType` no `onunload`** — guideline proíbe explicitamente |
| **MED** | Style guideline | `main.source.js:1770,1980,2075,2290,4779-4788` | Inline styles hardcoded (devia ir pro `styles.css`) |
| **MED** | UI guideline | `main.source.js:2336…2681` | `createEl('h2'/'h3')` em settings em vez de `setHeading()` |
| **MED** | Code quality | `main.source.js` (51×), `lib/*` (5×) | `console.log` spam — default deve mostrar só erros |
| **MED** | Adapter API | `main.source.js:2820,2835,3833` | `vault.adapter.basePath` (desktop-only) com guarda inconsistente |
| **LOW** | Resource mgmt | `main.source.js:1799,2076,4796` | `addEventListener` cru em vez de `registerDomEvent` |
| **LOW** | Code quality | `main.source.js:156` | `console.log` em top-level (dispara no import) |

> [!danger] Veredito: NÃO submissível como está
> Blockers de rejeição automática: descrição (tamanho + idioma + chars especiais), `detachLeavesOfType` no `onunload`, e console.log excessivo. Itens 1–3 corrigem-se numa edição de manifest; o `onunload` em 2 linhas. **Nota:** se o objetivo é uso pessoal (cápsula drop-in), a submissão à loja é opcional — mas as boas práticas (cleanup, logging) valem de qualquer forma.

## S7 — Conformidade arquitetural

| # | Princípio LOCKED | Veredito | Evidência |
|---|---|---|---|
| 1 | Base Apple-native inviolável (embed/ocr/vision sem fallback Twin) | ✅ CONFORMS | `/v1/embed`→NLContextualEmbedding, `/v1/ocr`→VNRecognizeText; Twin só cobre métodos generativos (`MLXAppleTwinProvider.swift:41-59`); nenhum handler base invoca Twin |
| 2 | Camada generativa intercambiável (Twin só p/ generativos) | ⚠️ CONFORMS c/ lacuna | Fallback é exclusivo dos generativos — **mas o Twin não está ligado** (ver #1 abaixo) |
| 3 | On-device-first (loopback antes de Tailscale) | ✅ CONFORMS | `main.source.js:363-484`: ordem `127.0.0.1` → `localhost` → setting → mesh; `winners.find(w=>w.loopback)` vence; só loopback é cacheado |
| 4 | HTTP-first com spawn fallback (macOS) | ✅ CONFORMS | `daemon-lifecycle.js:96-100`: checa `isHealthy(800)` antes; só spawna se health falha; mutex anti-corrida |
| 5 | Degradação graciosa iOS | ✅ CONFORMS c/ ressalva | `passport-index.js:82-89` cai pro `_buildOneLocal()` (JS); `leiden/multiplex/bm25` sem guards (rodam no iOS); spotlight guardado por `isMac()` |

> [!warning] Risco arquitetural #1 — Twin carregado mas não ligado
> `MLXAppleTwinBootstrap.swift` carrega o Twin (MLX Gemma) via ODR quando o Apple Intelligence falta, **mas `runFoundationModel()` (`AegisHTTPHandlers.swift:2233-2296`) retorna HTTP 503 sem nunca chamar `MLXAppleTwinProvider.shared`**. A maquinaria de fallback existe (protocolo cobre os 7 métodos generativos) mas o call-site nunca foi conectado. No iOS<26 os endpoints generativos degradam para 503 em vez de usar o Twin. Comentário no código Mac confirma: "Twin nunca é wired".
> **Fix:** em `runFoundationModel()`, no ramo de indisponibilidade, delegar para `MLXAppleTwinProvider.shared`.

> [!note] Risco arquitetural #2 — `zeus-spotlight-search` sem `isMac()`
> `main.source.js:3446` depende de `spotlightQueryEnabled` (default `false`) em vez de guarda `isMac()`. Se habilitado no iOS, falha graciosa (catch→Notice) mas confusa. **Fix:** adicionar `if (!isMac()) { … return; }` como nos comandos irmãos.

## S8 — Conformidade cross-device (re-auditoria de 17/05)

| # | Check | Veredito | Evidência |
|---|---|---|---|
| 1 | Zero `/Users/*` em JSONs sincronizados | ❌ **FAIL** | `data/passports.jsonl` (sincroniza via iCloud) tem 11 entradas com paths absolutos `/Users/rogermaiocchi/…/Memoria/…`. Inconsistente: 1ª entrada usa relativo (`README.md`), resto absoluto |
| 2 | Zero hostnames/IPs em config sincronizada | ❌ **FAIL** | `data.json:41` `"zeusDaemonUrl": "http://rogers-mac-mini:2223"`; `data/lexical-ios.jsonl` tem 2× `rogers-mac-mini`. Default do código é `127.0.0.1` — auto-probe reescreveu o hostname |
| 3 | `deviceId` em localStorage, não persistido | ⚠️ WARN | `saveSettings()` (`:4685`) tira `deviceId` por destructuring antes de salvar — mas `data.json` no disco ainda tem `deviceId` (write legado); cleanup em `:2994` não chama `saveSettings()` |
| 4 | Sem views fantasmas em `workspace.json` | ✅ PASS | `zeus-smart-view` registrado em `main.source.js:193` + `registerView():3710`. Não-órfão |
| 5 | Folders de plugin == `community-plugins.json` | ✅ PASS | 10 declarados / 10 presentes, match exato |
| 6 | `isDesktopOnly: false` | ✅ PASS | confirmado em prod e canônico |

> [!danger] Cross-device REGREDIU: 4/6 (era 6/6 em 17/05)
> **Regressões: Check 1 e Check 2.** Ambas vêm do mesmo mecanismo — auto-probe/indexação **escrevendo estado runtime (paths absolutos, hostname) em arquivos que sincronizam via iCloud**. Num MacBook/iPad/iPhone recebendo via iCloud, esses paths e hostname não resolvem → quebra o on-device-first e vaza topologia.
>
> **Remediação:** (1) `passports.jsonl` e `lexical-ios.jsonl` devem gravar paths **vault-relativos**, reconstruindo o absoluto em runtime com o `basePath` do device local. (2) Resultado de auto-discovery vai pra `localStorage` (per-device), nunca de volta pro `settings.zeusDaemonUrl` sincronizado, que deve ficar no default neutro `127.0.0.1`.

> [!note] Convergência com o Codex
> Os Checks 1, 2 e 3 do S8 batem com os HIGH #6, #7 e MED #8 do Codex — duas auditorias independentes apontando o mesmo cano furado (estado runtime vazando para arquivos sincronizados). Confiança alta.
