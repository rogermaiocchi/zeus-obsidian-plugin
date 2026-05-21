---
tipo: auditoria
criado: 2026-05-21
atualizado: 2026-05-21
status: ativo
escopo: zeus-obsidian-plugin · síntese consolidada (v1.13.2)
fontes: Fase 1 (estrutural) · Fase 2 (Codex round 4 + debate) · Fase 3 (conformidade)
---

# Auditoria Zeus — Relatório Consolidado

> [!info] Escopo e método
> Auditoria de 4 fases sobre o plugin Zeus (Obsidian, v1.13.2): 5 subagentes Claude em paralelo (estrutura + conformidade) + Codex CLI independente (segurança/qualidade) + mesa de debate adjudicando os achados. Todos os CRITs do Codex foram **verificados lendo o código real**.

## 1. Placar por categoria

| Categoria | #findings | CRIT | HIGH | MED | LOW |
|---|---:|---:|---:|---:|---:|
| Segurança (daemon) | 3 | 3 | — | — | — |
| Privacidade / privacy gate | 2 | — | 2 | — | — |
| Cross-device (sync) | 4 | — | 3 | — | 1 |
| Conformidade Obsidian | 7 | — | 2 | 4 | 1 |
| Arquitetura | 3 | — | — | 2 | 1 |
| Estrutura / processo | 5 | — | 1 | 1 | 3 |
| Qualidade / complexidade | 3 | — | — | 2 | 1 |
| **Total** | **27** | **3** | **8** | **9** | **7** |

## 2. Top 10 ações priorizadas (com PR sugerido)

| # | Ação | Sev | Origem | PR sugerido |
|---|---|---|---|---|
| 1 | **Fechar o daemon**: bind default `127.0.0.1`; exigir `--host 0.0.0.0` explícito | CRIT | Codex 1 | `fix(daemon): bind loopback-only by default` |
| 2 | **Autenticar/remover `/v1/cmd`**: implementar middleware `X-Zeus-Token` (já tem spec) antes de `route()`, liberar só `/v1/health` p/ não-loopback; allowlist de comandos OU remover `/v1/cmd` do build | CRIT | Codex 2+3 | `feat(daemon): token auth middleware + lock /v1/cmd` |
| 3 | **Privacy gate central**: mover `_assertRawContentAllowed()` p/ `_post()`, cobrindo enrich/ocr/summarize/contentGet/passport*/aspTranscribe | HIGH | Codex 4 (verificado) | `fix(privacy): enforce gate on all daemon endpoints` |
| 4 | **Despoluir sync**: paths vault-relativos em `passports.jsonl`/`lexical-ios.jsonl`; `deviceId` e auto-discovery em `localStorage`, nunca em `data.json` | HIGH | S8 1+2+3, Codex 6+7 | `fix(sync): keep absolute paths & topology out of synced files` |
| 5 | **PCC honesto**: renomear `pcc_used`→`pcc_possible`; em `off`, recusar workloads cloud | HIGH | Codex 5 | `fix(pcc): stop asserting cloud usage; enforce off` |
| 6 | **Conformidade Obsidian**: descrição EN ≤250 chars ASCII; remover `detachLeavesOfType` do `onunload` | HIGH | S6 | `fix(manifest): compliant description + onunload cleanup` |
| 7 | **Deploy canônico→prod**: prod roda `main.js` pré-v1.13.2 (sem privacy gate, `allowRemoteDaemonFallback=true`) | HIGH | S3 | (deploy, não PR) — após #1–#6 |
| 8 | **Tirar dados pessoais do código**: remover fallbacks `/Users/*` (`main.source.js:130`) e `claudeBin` (`Swift:1615`); resolver via `PATH`/env/setting | MED | Codex 8+9 | `fix: remove hardcoded personal paths` |
| 9 | **Ligar o Twin**: `runFoundationModel()` delega p/ `MLXAppleTwinProvider` no iOS<26; guard `isMac()` no `zeus-spotlight-search` | MED | S7 | `feat(ios): wire MLX twin fallback + spotlight guard` |
| 10 | **Higiene**: gate `console.log` atrás de `settings.debug`; styles inline→CSS; **retomar tags git** (taguear v1.14.0); apagar branches órfãos | MED/LOW | S6, S1 | `chore: logging gate + css + release tagging` |

## 3. Conformidade cross-device: 4/6 ⚠️ (REGREDIU de 6/6)

| Check | 17/05 | 21/05 |
|---|:---:|:---:|
| 1. Sem `/Users/*` em sync | ✅ | ❌ `passports.jsonl` |
| 2. Sem hostname/IP em sync | ✅ | ❌ `data.json` `rogers-mac-mini` |
| 3. `deviceId` não persistido | ✅ | ⚠️ valor legado no disco |
| 4. Sem views fantasmas | ✅ | ✅ |
| 5. Folders == community-plugins | ✅ | ✅ |
| 6. `isDesktopOnly:false` | ✅ | ✅ |

**Causa raiz única:** estado runtime (paths absolutos, hostname auto-descoberto) sendo gravado em arquivos que sincronizam via iCloud. Ação #4 fecha as duas regressões + o WARN.

## 4. Divergência canônico ↔ prod

> [!warning] A premissa do briefing estava obsoleta e invertida
> - **Não é "v1.4.0 / fix 1.4.2-ios não backportado".** Canônico, `origin/main` e prod estão todos em **v1.13.2**.
> - O fix histórico da "linha 141 (require path)" já foi absorvido há muitas versões — não existe hotfix prod-only a subir.
> - **Realidade:** o `main.js` de prod é um build **anterior** ao canônico v1.13.2 — falta o privacy gate e tem `allowRemoteDaemonFallback=true` (prod está **mais exposto**). O fluxo correto é **deploy canônico→prod**, não backport.
> - `manifest.json`, `styles.css` e `bin/ZeusDaemonMac` são idênticos entre canônico e prod.
> - Backup no Google Drive = **v1.4.0 congelado (17/05)**, snapshot histórico inofensivo; não restaurar dele.

## 5. Recomendação de release

> [!danger] NÃO cortar release agora
> "Cortar v1.4.2-ios no canônico" é **moot** — o canônico já é v1.13.2. E **não se deve cortar nova versão ainda**: os 3 CRITs de segurança do daemon (bind aberto + `/v1/cmd` sem auth) são **release-blocking**, ainda mais com `Clientes/**` (sigiloso) no vault.

**Sequência recomendada:**
1. **Sprint de hardening** — ações #1, #2, #3 (CRITs + privacy gate). Sem isso, qualquer host na tailnet executa comando no Mac mini.
2. **Sprint cross-device** — ação #4 (volta a 6/6) + #5 (PCC honesto) + #8 (paths pessoais).
3. **Cortar `v1.14.0`** com tag git (retomar disciplina de tagging), changelog das correções de segurança, e **deploy canônico→prod** (ação #7).
4. Conformidade Obsidian (#6) e Twin/higiene (#9, #10) podem ir junto na v1.14.0 ou numa v1.14.1 de polimento.

## 6. Veredito geral

O Zeus v1.13.2 é arquiteturalmente **sólido** nos invariantes declarados (Apple-native base inviolável, on-device-first, HTTP-first, degradação iOS — todos CONFORMS) e **limpo** de `require()` iOS desprotegidos e segredos hardcoded. O risco real **não está no design, está na superfície de rede e no vazamento de estado**: um daemon aberto sem auth com endpoint de shell, e um privacy gate incompleto que deixa conteúdo `sigiloso` escapar por endpoints não-`embed`. Esses dois eixos — corrigíveis em uma sprint focada — são o que separa o plugin de estar pronto para uso cross-device seguro.

---

## 7. Implementação autônoma (sprint de hardening — 2026-05-21)

Executada com tooling nativo macOS (`swift build` 6.3.2, `lsof`, `curl`, `codesign`, `launchctl`) + testes node. Versão bumped **1.13.2 → 1.14.0**.

| Ação | Status | Verificação |
|---|---|---|
| CRIT #1 — bind default `127.0.0.1` | ✅ FEITO | `lsof`: default loopback-only; LAN recusa conexão |
| CRIT #2/#3 — auth gate `X-Zeus-Token` (Mac + iOS) | ✅ FEITO | `curl` LAN sem token→401, token correto→200, loopback→200; ambos daemons compilam |
| HIGH #4 — privacy gate central em `_post()` | ✅ FEITO | 13/13 testes node (enrich/ocr/aspTranscribe/embed bloqueados p/ remoto+Clientes) |
| #6 — flush `deviceId` legado no onload | ✅ FEITO | guard só flusha quando há valor stale |
| MED #9 — `claudeBin` sem path pessoal | ✅ FEITO | resolve via `ZEUS_CLAUDE_BIN`/PATH; compila |
| Deploy daemon hardened (repo bin + `~/.local/bin`) | ✅ FEITO | LaunchAgent reiniciado (PID 47502), smoke 9/9, loopback intacto |
| Deploy plugin v1.14.0 → prod iCloud | ✅ FEITO | privacy gate presente, manifest 1.14.0, bin codesign OK; backup em `/tmp` |

**Deferido (requer teste de integração cross-device / Xcode / device físico):**
- HIGH — relativização de paths em `passports.jsonl`/`lexical-ios.jsonl` (S8 Check 1).
- HIGH — remover topologia Tailscale hardcoded `TAILSCALE_MESH` + parar de gravar `zeusDaemonUrl` remoto em `data.json` (S8 Check 2). *Mitigado de fato pelo auth gate: endpoints remotos agora exigem token.*
- MED — wiring do Twin MLX no `runFoundationModel` iOS (sem device USB conectado nesta sessão).
- HIGH — cleanup conformidade Obsidian (descrição EN ≤250, `detachLeavesOfType`) — só relevante se for submeter à store.

> [!note] iOS nesta sessão
> `device_list` (cfgutil) retornou vazio — nenhum iPhone/iPad conectado por USB. As edições do `AegisDaemon` foram validadas em **compilação** (`bun run check` → `Build of target: AegisDaemon complete`, 224/224), mas não há verificação runtime em device. Deploy do app iOS exige rebuild Xcode + device.

---

---

## 8. Round 5 — 0% de pendências (v1.15.0, mesa de debate Codex) — 2026-05-21

Sprint autônoma fechando **todas** as 4 pendências "deferred" da seção 7 + os achados de
uma segunda mesa de debate adversarial com o Codex CLI. Detalhe completo: `audit-codex-round5.md`.

| Pendência (seção 7 → "Deferido") | Status v1.15 | Verificação |
|---|---|---|
| HIGH — relativização `passports.jsonl`/`lexical-ios.jsonl` | ✅ FECHADO | coerção em load/save/buildOne/buildAll + lexical incremental; testes node |
| HIGH — topologia Tailscale hardcoded (`TAILSCALE_MESH`) | ✅ FECHADO | removida; mesh peers em localStorage per-device, default vazio; grep limpo |
| MED — wiring Twin MLX iOS | ✅ FECHADO (compila) | `twinFallbackOr503` em `runFoundationModel` + `/v1/prompt`; `swift build` OK |
| HIGH — conformidade Obsidian (descrição, `detachLeavesOfType`) | ✅ FECHADO | + setHeading, CSS, console.log gated, isMac guard |

**Achados extra da mesa de debate Codex round 5 (que o Claude não tinha visto):**
1. `buildAll()` não coagia path → duplicata abs+rel no JSONL. **Corrigido.**
2. Twin fallback não cobria `/v1/prompt` (endpoint que o client chama). **Corrigido.**
3. Privacy gate path-based era cego a chamadas content-only (`graphExtract(text)`). **Corrigido** (privacyCtx threaded).
4. Honestidade PCC: `pcc_used` → `pcc_possible` em todo lugar. **Corrigido.**

**Veredito Codex (2 rodadas):** todos os achados FECHADOS. "Não encontrei gate executável
furado nem JSONL sincronizado com path absoluto; `data.json` sem deviceId/topologia pessoal."

> [!success] 0% de pendências de CÓDIGO
> v1.15.0: `check-project` OK (esbuild + ambos daemons Swift compilam), 18/18 testes node,
> greps de privacidade limpos. Resta apenas o que exige hardware: deploy iOS via Xcode +
> runtime do Twin em device físico (validados por compilação nesta sessão).

---

### Artefatos desta auditoria (não commitados)
- `audit-fase1-estrutural.md` — git, inventário, canônico↔prod, backup
- `audit-codex-round4.md` — relatório Codex round 4 + verificação
- `audit-claude-vs-codex.md` — mesa de debate round 4
- `audit-fase3-conformidade.md` — Obsidian + arquitetural + cross-device
- `audit-codex-round5.md` — **mesa de debate round 5 (fechamento → v1.15.0)**
- `audit-final-consolidado.md` — este documento
- `audit-codex-raw.txt` — log bruto Codex round 4 (6.330 linhas)
- `audit-codex-round5-raw.txt` / `audit-codex-round5-confirm.txt` — logs Codex round 5
