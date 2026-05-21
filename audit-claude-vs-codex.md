---
tipo: auditoria
criado: 2026-05-21
atualizado: 2026-05-21
status: ativo
escopo: zeus-obsidian-plugin · Fase 2 (mesa de debate)
---

# Mesa de Debate — Claude vs Codex

> [!info] Método
> 5 subagentes Claude (Sonnet) fizeram a varredura estrutural e de conformidade em paralelo; o Codex CLI fez auditoria independente de segurança/qualidade. Aqui adjudico cada achado, resolvendo concordâncias e divergências com leitura do código real.

## 1. Findings do Codex — concordância

| Codex | Veredito do Claude | Justificativa |
|---|---|---|
| **CRIT daemon `0.0.0.0`** | **CONCORDO** (verificado) | `main.swift:28` literal. Os agentes Claude **não olharam** o bind do daemon. |
| **CRIT `/v1/cmd` sem auth** | **CONCORDO** (verificado) | `route()` despacha sem gate; handler executa shell. Achado mais grave da rodada. |
| **CRIT token auth não implementado** | **CONCORDO** (verificado) | Spec existe, código não. Zero refs a `X-Zeus-Token`. |
| **HIGH privacy gate só em `embed()`** | **CONCORDO — e corrijo o S3** | S3 disse "gate adicionado"; estava certo que existe, mas **errou na cobertura**. Verifiquei: gate só na linha 286 (`embed`). 12 outros métodos sem gate. |
| **HIGH `deviceId` em `data.json`** | **CONCORDO** | S8 marcou WARN; Codex marca HIGH. **Codex tem razão na severidade**: o valor sincroniza hoje, não é só "vai se auto-curar". |
| **HIGH topologia hardcoded** | **CONCORDO** | S8 também pegou (`rogers-mac-mini` em `data.json` + `lexical-ios.jsonl`); Codex achou a fonte (`main.source.js:366`). Complementares. |
| **MED `/Users` fallbacks + `claudeBin`** | **CONCORDO** (verificado) | `claudeBin = /Users/maiocchi/...` — username errado, quebra em qualquer device. |
| **MED complexidade/duplicação** | **CONCORDO** | Bate com o inventário do S2 (handlers de 3.455 e 2.733 linhas). |
| **HIGH PCC heurístico** | **CONCORDO (com ressalva)** | Plausível e importante; não reli a inferência de tamanho linha-a-linha. Marcar para verificação dedicada antes de afirmar "PCC usado" na UI. |

**Discordâncias com o Codex: nenhuma.** Todos os CRIT/HIGH conferidos bateram com o código.

## 2. Findings que o Claude achou e o Codex NÃO viu

> [!example] O Codex focou em segurança de runtime/daemon; perdeu o eixo de *conformidade de plataforma*.

| Achado | Fonte | Severidade |
|---|---|---|
| **Plugin NÃO submissível à community store**: descrição com 891 chars (limite 250), em **português**, com chars especiais `·`/`⊕` | S6 | HIGH (blocker de submissão) |
| **`detachLeavesOfType` no `onunload`** — explicitamente proibido pelo guideline Obsidian (`main.source.js:4620`) | S6 | HIGH (blocker) |
| **`passports.jsonl` com paths absolutos `/Users/` E sincroniza via iCloud** — quebra em outro device | S8 (Check 1) | HIGH (cross-device) |
| **Conformidade cross-device regrediu 6/6 → 4/6** (Checks 1 e 2 falharam desde 17/05) | S8 | HIGH |
| **Twin MLX carregado mas NÃO ligado**: `runFoundationModel` retorna 503 no iOS<26 em vez de cair pro MLX | S7 | MED |
| `console.log` spam (51 em `main.source.js`) — viola guideline | S6 | MED |
| Inline styles + `createEl('h2')` em vez de `setHeading()` nas settings | S6 | MED |
| `zeus-spotlight-search` sem guard `isMac()` | S7 | LOW |
| Sem tags git desde v1.4.0; 2 branches órfãos | S1 | LOW |
| Zero TypeScript; binário Swift commitado sem CI | S2 | LOW |

## 3. Findings que o Codex viu e o Claude NÃO viu

> [!example] O ponto cego do Claude foi a superfície de rede do daemon.
> O S7 auditou **conformidade arquitetural** (invariantes Apple-native, ordem de fallback, degradação iOS) e concluiu "CONFORMS" em 5/5 — mas **nunca testou o endereço de bind nem a autenticação do `/v1/cmd`**. Tudo que o S7 validou (loopback-first no *cliente*) é verdade, e ainda assim o *servidor* está aberto em `0.0.0.0` sem auth. Lição: conformidade de design ≠ postura de segurança.

| Achado exclusivo do Codex | Por que o Claude perdeu |
|---|---|
| Bind `0.0.0.0` default | S7 olhou o cliente (discovery loopback-first), não o servidor |
| `/v1/cmd` RCE sem auth | Fora do escopo declarado dos subagentes (conformidade, não pentest) |
| Token middleware não implementado | Idem — ninguém leu a spec vs implementação |
| `claudeBin` hardcoded no Swift | S2 inventariou Swift mas não grepou paths pessoais |

## 4. Consenso de prioridade (debate resolvido)

Severidade final combinada, ordenada por risco × esforço:

1. **CRIT** — Daemon `0.0.0.0` + `/v1/cmd` sem auth + token middleware ausente → **cadeia única de RCE na tailnet**. (Codex 1+2+3)
2. **HIGH** — Privacy gate só em `embed()`; vazamento de conteúdo `sigiloso` por `enrich`/`ocr`/`summarize`/`contentGet` para daemon remoto. (Codex 4, verificado)
3. **HIGH** — Topologia + `deviceId` sincronizados em `data.json`/`passports.jsonl`/`lexical-ios.jsonl`; **cross-device regrediu 6/6→4/6**. (Codex 6+7 ∪ S8 1+2)
4. **HIGH** — `passports.jsonl` com paths absolutos sincronizados. (S8 1)
5. **HIGH** — PCC `pcc_used` heurístico, não enforcement. (Codex 5)
6. **HIGH** — Blockers de submissão Obsidian: descrição + `detachLeavesOfType`. (S6)
7. **HIGH** — Deploy canônico→prod (prod está atrás, com `allowRemoteDaemonFallback=true`). (S3)
8. **MED** — `/Users` fallbacks + `claudeBin` hardcoded. (Codex 8+9)
9. **MED** — Twin MLX não ligado; complexidade/duplicação Mac↔iOS. (S7 ∪ Codex 10)
10. **MED/LOW** — console.log, styles inline, guards `isMac()`, tags git, branches órfãos.

> [!tip] Síntese do debate
> **Codex venceu o eixo segurança** (3 CRITs que o Claude não viu). **Claude venceu o eixo conformidade de plataforma** (submissão Obsidian, regressão cross-device, Twin não-ligado). Os dois **convergiram** no privacy gate incompleto e na topologia sincronizada — o que aumenta a confiança nesses dois. Nenhuma contradição factual entre as duas auditorias.
