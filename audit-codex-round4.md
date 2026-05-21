---
tipo: auditoria
criado: 2026-05-21
atualizado: 2026-05-21
status: ativo
escopo: zeus-obsidian-plugin · Fase 2 (Codex CLI round 4)
ferramenta: OpenAI Codex CLI 0.130.0 (ChatGPT login) · modo somente-leitura
---

# Auditoria Zeus — Codex CLI Round 4

> [!info] Procedência
> Executado via `codex exec` (não-interativo) sobre o checkout canônico v1.13.2. Saída bruta completa (6.330 linhas de log de sessão): `audit-codex-raw.txt`. Abaixo, o relatório final do Codex + **anotações de verificação do Claude** (cada CRIT foi conferido lendo o código real — ver coluna ✓).

## Resumo do Codex

- **`require()` Node desprotegido no runtime iOS:** **0 encontrados**. `path`, `fs`, `child_process`, `os`, `net`, `http` estão todos em `try/catch`. `node:http` só aparece em scripts CLI, fora do plugin iOS. Exemplos guardados: `main.source.js:58,59,149,3831`, `lib/universal-fs.js:33-37`, `lib/daemon-lifecycle.js:45-51`, `lib/hybrid-search.js:371-372`.
- **Segredos hardcoded:** **nenhuma API key/token real** encontrada por padrões comuns.
- **PCC:** default `off`, mas o daemon **não garante enforcement real**; telemetria `pcc_used` é heurística.

## 10 itens críticos do Codex (+ verificação Claude)

| # | Sev | Local | Problema | ✓ Claude verificou |
|---|---|---|---|---|
| 1 | **CRIT** | `daemon/.../main.swift:28` | Daemon Mac faz bind default em **`0.0.0.0`** — expõe HTTP na LAN/tailnet | ✅ confirmado: `var host = "0.0.0.0"` (comentário "aceitar conexões Tailscale") |
| 2 | **CRIT** | `ZeusMacHTTPHandler.swift:293` (handler `:1485`) | **`/v1/cmd` sem auth** executa comandos shell (`cat`, `ssh`, `osascript`, `curl`, `git`, `claude`); CORS `*` em `:3338` | ✅ confirmado: `route()` (linha 269) despacha direto, sem gate; handler "macOS system commands" |
| 3 | **CRIT** | spec `daemon-token-auth-design.md:25` vs handler `:269` | Design exige `X-Zeus-Token` para não-loopback, mas **middleware nunca foi implementado** | ✅ confirmado: 0 ocorrências de `X-Zeus-Token`/auth no handler |
| 4 | **HIGH** | `lib/zeus-http-client.js:283,332` | Privacy gate **só em `embed()`**; `embedBatch`, `enrich`, `summarize`, `ocr`, `aspTranscribe`, `contentGet`, `passport*` enviam conteúdo/path sem gate | ✅ confirmado: `_assertRawContentAllowed` só chamado na linha 286 |
| 5 | **HIGH** | `zeus-http-client.js:191` + `ZeusMacHTTPHandler.swift:2382` | PCC default `off`, mas `pcc_used` é **inferido por tamanho**, não uso real; `off` não recusa workloads cloud | conferência parcial (lógica heurística plausível) |
| 6 | **HIGH** | `data.json:50` | `deviceId` **persistido em arquivo sincronizado** apesar do código dizer "só localStorage" | ✅ confirmado (cf. S8 Check 3) |
| 7 | **HIGH** | `main.source.js:366` | **IPs Tailscale + hostname pessoal** hardcoded (`100.108.x.x`, `rogers-mac-mini.local`) | ✅ confirmado (cf. S8 Check 2) |
| 8 | **MED** | `main.source.js:130` | Fallbacks absolutos `/Users/rogermaiocchi` e `/Users/maiocchi` no plugin | confirmado por padrão (cf. S8) |
| 9 | **MED** | `ZeusMacHTTPHandler.swift:1615` | `claudeBin = "/Users/maiocchi/.local/bin/claude"` hardcoded | ✅ confirmado — e nota: `maiocchi` ≠ `rogermaiocchi`, **duplamente quebrado** |
| 10 | **MED** | `main.source.js:2810` + `ZeusMacHTTPHandler.swift:269` | Complexidade alta: `onload()` ~1800 linhas; handlers Swift concentram dezenas de endpoints; **duplicação Mac↔Aegis** | ✅ confirmado (cf. S2) |

## Cadeia de ataque dos 3 CRITs (a verdadeira manchete)

> [!danger] RCE não-autenticado na LAN/tailnet
> Os 3 CRITs **compõem um único vetor**:
> 1. O daemon escuta em **todas as interfaces** (`0.0.0.0:2223`), não só loopback.
> 2. O endpoint **`/v1/cmd` executa comandos de shell** (incl. `ssh`, `curl`, `osascript`, `claude`).
> 3. **Não há autenticação** — o middleware de token foi *desenhado* (spec de 16/05) mas **nunca ligado**; CORS é `*`.
>
> Resultado: **qualquer host na mesma LAN ou tailnet** do Mac mini pode `POST /v1/cmd` e executar comandos arbitrários na máquina do Roger. Como o vault contém `Clientes/**` (sigiloso), o impacto cruza o privacy gate jurídico. **Release-blocking.**

## Correções recomendadas pelo Codex

1. **#1** default `127.0.0.1`; exigir `--host 0.0.0.0` explícito + auth obrigatória.
2. **#2** remover `/v1/cmd` do build público OU proteger com token local + allowlist mínima + bloquear não-loopback.
3. **#3** middleware de auth antes de `route()`, liberando só `/v1/health`.
4. **#4** aplicar `_assertRawContentAllowed()` **centralmente em `_post()`** por endpoint/payload.
5. **#5** renomear `pcc_used`→`pcc_possible` (não afirmar uso); em `off`, recusar workloads que exigiriam cloud.
6. **#6** remover `deviceId` de `data.json`; migração no `onload()` salvando sem o campo.
7. **#7** mover topologia (IPs/hostname) para config local não-sincronizada ou discovery dinâmico.
8. **#8/#9** remover fallbacks pessoais; resolver via `manifest.dir`, `PATH`, env ou setting local.
9. **#10** modularizar `onload()`/`route()`; extrair contrato comum Mac/iOS.

> [!note] O que o Codex NÃO cobriu
> Conformidade Obsidian community store (descrição, `detachLeavesOfType`), regressões cross-device específicas de `passports.jsonl`, e o Twin MLX carregado-mas-não-ligado. Esses vieram dos agentes Claude — ver `audit-claude-vs-codex.md`.
