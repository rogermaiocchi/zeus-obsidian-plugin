---
tipo: auditoria
criado: 2026-05-21
atualizado: 2026-05-21
status: ativo
escopo: zeus-obsidian-plugin · round 5 (mesa de debate Codex — fechamento das pendências v1.14)
ferramenta: OpenAI Codex CLI 0.130.0 · codex exec -s read-only
---

# Auditoria Zeus — Round 5: Mesa de Debate Codex (fechamento → v1.15.0)

> [!info] Objetivo
> Levar a **0% de pendências** os itens "deferred" da v1.14.0 (auditoria round 4) e
> submeter o resultado a uma **mesa de debate adversarial com o Codex CLI**. Duas
> rodadas: (1) Codex audita as 10 correções + caça regressões; (2) Codex confirma o
> fechamento dos achados da rodada 1. Logs brutos: `audit-codex-round5-raw.txt`,
> `audit-codex-round5-confirm.txt`.

## 1. As 10 correções implementadas (Claude)

| # | Pendência v1.14 (deferred) | Sev | Fix | Arquivo |
|---|---|---|---|---|
| 1 | manifest description 891 chars PT + `·`/`⊕` | HIGH | EN, 220 chars, ASCII | `manifest.json` |
| 2 | `detachLeavesOfType` no `onunload` | HIGH | removido | `main.source.js` onunload |
| 3 | topologia Tailscale hardcoded (`TAILSCALE_MESH`) | HIGH | localStorage per-device, default vazio + UI | `main.source.js` |
| 4 | `deviceId` no `data.json` sincronizado | HIGH | removido (flush legado já existia) | `data.json` |
| 5 | `passports.jsonl`/`lexical-ios.jsonl` paths absolutos | HIGH | coerção vault-relativa em load/save/buildOne/buildAll + lexical incremental | `lib/passport-index.js`, `lib/lexical-ios.js` |
| 6 | PCC `pcc_used` heurístico afirmado como uso real | HIGH | rename → `pcc_possible` (Swift+JS+UI+header), off=false | `ZeusMacHTTPHandler.swift`, `lib/zeus-http-client.js`, `main.source.js` |
| 7 | fallbacks `/Users/rogermaiocchi`,`/Users/maiocchi` | MED | via `$HOME`/`$USER` | `main.source.js` |
| 8 | Twin MLX carregado mas não ligado (iOS 503) | MED | `twinFallbackOr503` em `runFoundationModel` + `/v1/prompt` | `AegisHTTPHandlers.swift` |
| 9 | `console.log` spam (52) | MED | `dbg()` gated em `settings.debug` + toggle | `main.source.js`, `lib/passport-scheduler.js` |
| 10 | headings/inline styles/addEventListener/isMac | MED/LOW | `setHeading()`, CSS classes, `registerDomEvent`, guard | `main.source.js`, `styles.css` |

## 2. Mesa de debate — rodada 1 (Codex adversarial)

Codex CONCORDOU integralmente com #1, #2, #3, #4, #7. Marcou #5, #6, #8, #9, #10 como
PARCIAL e — agindo como auditor adversarial — encontrou **achados reais que o Claude
deixara escapar**:

| Achado Codex (round 5) | Sev | Veredito Claude | Ação |
|---|---|---|---|
| `buildAll()` faz `map.set(p.path)` sem coagir → duplicata abs+rel | **HIGH** | **PROCEDE** (verificado) | coerção antes do `map.set` |
| Twin fallback não cobre `/v1/prompt` (handlePrompt 503 direto) | **MED** | **PROCEDE** (verificado) | rota `/v1/prompt` por `twinFallbackOr503` + payload `text`+`output` |
| Privacy gate path-based cega em content-only (`graphExtract(text)`) | **HIGH** | **PROCEDE** (verificado) | `privacyCtx` em graphExtract/summarize/refine/classify/prompt + caller passa `_privacyPath` |
| `lexical-ios.jsonl` sem coerção de path | MED | PARCIAL (índice já era relativo por construção) | coerção defensiva em `incremental()` |
| Semântica PCC stale em UI/comentários | LOW | PROCEDE | textos/comentários corrigidos p/ "possibilidade" |
| `bm25` demo console.log no bundle | LOW | IMPROCEDE | dead code (`require.main === module`, nunca executa) |
| version não bumped | LOW | PROCEDE | 1.15.0 em manifest+package |

> [!tip] Por que o debate valeu
> O Codex achou **3 furos que o Claude não viu**: (1) o chokepoint de path tinha um
> caminho secundário (`buildAll`); (2) o wiring do Twin cobria o runner genérico mas
> não o `/v1/prompt` que o client de fato chama; (3) o gate de privacidade, sendo
> path-based, era cego a chamadas que mandam só texto. Os três foram corrigidos.

## 3. Mesa de debate — rodada 2 (confirmação)

| Achado | Veredito Codex (confirmação) | Evidência |
|---|---|---|
| A — `buildAll` coerção | **FECHADO** | `lib/passport-index.js` (antes do map.set) |
| B — `/v1/prompt` Twin + payload `text`/`output` | **FECHADO** | `AegisHTTPHandlers.swift` handlePrompt + twinFallbackOr503 |
| C — privacyCtx content-only | **FECHADO** | `_post` + 5 métodos + caller graphExtract |
| D — lexical-ios coerção | **FECHADO** | `lib/lexical-ios.js` incremental |
| E — semântica PCC | **FECHADO após 2º patch** | restavam 3 comentários stale (`main.source.js`, `lib/zeus-http-client.js`); corrigidos + rebuild |
| F — versão 1.15.0 | **FECHADO** | manifest + package |

> [!success] Veredito final do Codex
> "Não encontrei gate executável furado nem JSONL sincronizado com path absoluto neste
> worktree; `data.json` não tem deviceId/topologia pessoal." Após o 2º patch dos
> comentários PCC, **todos os achados FECHADOS** → 0% de pendências no código.

## 4. Verificação

- `node scripts/check-project.mjs` → **OK** (esbuild bundle + plist + `swift build` ZeusDaemonMac **e** AegisDaemon compilam).
- Testes node: **18/18 asserts** (coerção de path load/save/buildOne, rename PCC, gate de privacidade content-only bloqueando remoto+`Clientes/`, permitindo loopback).
- Greps de privacidade: 0 IPs `100.x`, 0 `rogers-mac-mini`, 0 `/Users/<user>` pessoal, 0 `TAILSCALE_MESH`, 0 `deviceId` em `data.json`, 0 afirmações de "routing real" PCC.

> [!note] Limite honesto desta sessão
> Itens que exigem device físico — deploy do app iOS (Xcode) e runtime do Twin MLX em
> iPhone/iPad — seguem validados por **compilação**, não por execução em device (sem
> iPhone/iPad por USB nesta sessão). O daemon Mac hardened **não foi redeployado** em
> prod (smoke rodou contra o daemon vivo atual, 9/9, confirmando o contrato intacto).
