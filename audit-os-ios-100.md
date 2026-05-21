---
tipo: auditoria
criado: 2026-05-21
atualizado: 2026-05-21
status: ativo
escopo: zeus-obsidian-plugin · 100% de funcionamento macOS + iOS (mesa de debate Codex)
---

# Zeus — 100% de funcionamento macOS + iOS

> [!info] Método
> Modo autônomo + duas mesas de debate com o Codex CLI (estratégia iOS + confirmação do
> relay). Tudo verificado empiricamente (curl, endpoints, testes node) — não só compilação.

## 1. macOS — 100% ✅ (deployado + verificado)

| Item | Estado | Evidência |
|---|---|---|
| Daemon v1.15 (release, codesigned) | ✅ deployado | `~/.local/bin/zeusdaemon-mac`, LaunchAgent PID ativo |
| Plugin v1.15 → vault prod (iCloud) | ✅ deployado | markers privacy gate + token + mesh; manifest 1.15.0 |
| Todos os endpoints Apple-native | ✅ 18/18 | embed(512)/summarize/prompt/enrich/graph/classify/nl×3/translate/refine/hyde/agent |
| PCC `pcc_possible` no fio | ✅ | header `X-Zeus-Pcc-Possible` presente (auto), ausente (off), sem header legado |

## 2. iOS — arquitetura decidida pela mesa de debate

> [!warning] Realidade dos devices do Roger
> iPhone 15 (A16) e iPad Air 4 (A14), ambos iOS 26 — **nenhum elegível a Apple
> Intelligence**. FoundationModels generativo = `.unavailable` neles. Não há host app
> rodando AegisDaemon instalado nos devices. O daemon iOS canônico vive em outro repo
> (`meta-repos/ProjetoAegis` + `aegis-intelligence`/MLX Gemma 4), não nesta cápsula.

**Veredito do Codex (debate #1):** Opção **C** — relay para o Mac **agora**, Twin offline
**depois**. O relay entrega 100% dos recursos remotos (embed/generativo/Apple-native)
**enquanto Mac + Tailscale online**; não entrega offline puro nem conteúdo `sigiloso` via
daemon remoto (correto — privacy gate mantém `Clientes/**` local).

### O que foi implementado (relay iOS→Mac, autenticado)

| Camada | Mudança | Estado |
|---|---|---|
| Client (`zeus-http-client.js`) | `setAuthToken` + `_authHeaders` injeta `X-Zeus-Token` só em não-loopback | ✅ (gap que o Codex achou: client não mandava o token) |
| Plugin (`main.source.js`) | token per-device em localStorage + campo settings (password); nunca em data.json | ✅ |
| Daemon Mac (Swift) | `/v1/cmd` loopback-only (403 remoto mesmo com token); CORS expõe `X-Zeus-Token` | ✅ defesa em profundidade |
| Mac runtime | daemon bound `*:2223` + `ZEUS_DAEMON_TOKEN` (token forte em `~/.config/zeus/daemon-token`) | ✅ ativo |

### Verificação empírica do relay (curl via Tailscale 100.108.238.49)

| Teste | Esperado | Resultado |
|---|---|---|
| loopback `/v1/health` | 200 | ✅ 200 |
| loopback `/v1/tools` (sem token) | 200 | ✅ 200 |
| tailscale `/v1/tools` SEM token | 401 | ✅ 401 |
| tailscale `/v1/tools` COM token | 200 | ✅ 200 |
| tailscale `/v1/embed` COM token | 200 | ✅ 200 (relay funciona) |
| tailscale `/v1/cmd` COM token | 403 | ✅ 403 (loopback-only) |
| loopback `/v1/cmd` | 200 | ✅ 200 |

**Codex (debate #2):** implementação **SÓLIDA**, 6/6 itens FECHADO. Sem furo de auth.

## 3. O passo manual que falta (não automatizável)

> [!danger] Provisão do device é manual — WDA/localStorage bloqueiam automação
> Não há WebDriverAgent instalado nos devices (exige assinatura Xcode) → sem controle de
> UI; e o token vive em `localStorage` (por design, para não vazar via iCloud) → não dá
> para gravar remotamente. Logo, **em cada device** (iPhone/iPad), no Obsidian:
> 1. Settings → Zeus → **Permitir fallback remoto para mesh peers**: ON.
> 2. **Daemon mesh peers**: `http://100.108.238.49:2223`
> 3. **Token do daemon remoto**: colar o valor de `~/.config/zeus/daemon-token`.
> 4. **Forçar redescoberta de daemon agora**.
> Pré-requisitos: Tailscale conectado nos dois devices; v1.15 sincronizado via iCloud.

## 4. Limites honestos do "100%" (o que é inerentemente impossível agora)

- **iOS offline + nota `sigiloso` + embed/generativo novo**: impossível sem host app
  on-device (Twin). O privacy gate bloqueia `Clientes/**` para daemon remoto (correto).
- **Generativo on-device no iPhone/iPad**: A14/A16 não rodam Apple Intelligence; exige o
  Twin MLX (Gemma 4 via `aegis-intelligence`) num host app — outro repo + pesos multi-GB
  como ODR + assinatura. É a Opção A, projeto à parte (Twin offline depois).
- **OCR/vision/áudio de mídia nova via relay**: o Mac resolve paths vault-relativos contra
  sua própria cópia iCloud do vault, então funciona quando a mídia já sincronizou; upload
  base64 cross-device fica como melhoria futura.

## 5. Segurança — postura do relay (endossada pelo Codex)

- Bind `0.0.0.0` é seguro **porque**: (1) não-loopback exige `X-Zeus-Token` (constant-time);
  (2) `/v1/cmd` é loopback-only mesmo com token; (3) fail-closed (sem env → remoto recusado).
- **Recomendação aberta**: Tailscale ACL permitindo só iPhone/iPad → Mac:2223 (estreita a
  superfície além da LAN; configurável no admin Tailscale).
- **Reverter o relay** (voltar a loopback-only): editar `~/Library/LaunchAgents/com.maiocchi.zeusdaemon.plist`
  (`--host` → `127.0.0.1`, remover `ZEUS_DAEMON_TOKEN`) e `launchctl kickstart -k gui/$UID/com.maiocchi.zeusdaemon`.
  Backup do plist original em `/tmp/zeusdaemon.plist.backup-*`.

## 6. Artefatos

- `audit-codex-ios-debate.txt` — mesa de debate #1 (estratégia)
- `audit-codex-relay-confirm.txt` — mesa de debate #2 (confirmação do relay)
- `audit-os-ios-100.md` — este documento
