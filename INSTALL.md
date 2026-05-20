# Zeus — Instalação

> v1.5 — autonomia drop-in. O plugin embarca o daemon Apple-nativo (`bin/ZeusDaemonMac`, arm64, codesigned adhoc). **Nenhum `swift build`, `bash install-*.sh` ou `pip install` é necessário do lado do usuário.**

## Pré-requisitos do dispositivo

| Plataforma | Requisito | Onde valida |
|---|---|---|
| Apple Silicon Mac | macOS 26+ (Sequoia/Tahoe) com Apple Intelligence habilitado | System Settings → Apple Intelligence & Siri |
| iPhone / iPad | iOS/iPadOS 17.4+ (read-only via iCloud) | n/a — plugin detecta sandbox e degrada gracioso |
| Obsidian | 1.5+ | About → Version |

Não há dependência externa. `swift`, Xcode, Python, Homebrew, Tailscale — todos opcionais.

## Instalação

1. Baixe o release `.zip` do plugin.
2. Extraia em `<seu-vault>/.obsidian/plugins/zeus/` (deve conter `manifest.json`, `main.js`, `styles.css`, `bin/ZeusDaemonMac`).
3. Settings → Community plugins → habilite **Zeus**.
4. Cmd+P → `Zeus: reindexar vault completo` (primeira indexação).

Pronto. O plugin no Mac sobe `bin/ZeusDaemonMac` em foreground (porta 2223 loopback) e mata o processo quando o Obsidian fecha. Cmd+P → `Zeus: status do daemon HTTP` mostra o estado.

## Como o lifecycle funciona

- **Daemon já vivo** (ex: você já tem LaunchAgent rodando) → plugin reaproveita. Não faz spawn, não interfere.
- **Daemon ausente** → plugin spawna `bin/ZeusDaemonMac --port 2223 --host 127.0.0.1` no `onload()`, monitora `/v1/health` por até 10s. Sucesso → opera normal. Falha → degrada gracioso (Notice no Settings tab) e Obsidian continua funcional.
- **iOS Capacitor** (sem `child_process`) → plugin nunca tenta spawn. Lê `data/embeddings.jsonl` syncado via iCloud do Mac. Busca cai para substring; semântica fica disponível quando o vault syncar do Mac.

## Cross-device (opcional)

Vault em iCloud Drive sincroniza automaticamente entre Mac e iPhone/iPad. Plugin instalado no Mac propaga `.obsidian/plugins/zeus/` para os outros devices. iOS lê os embeddings pré-computados pelo Mac.

Para querer rodar a IA também no Mac de outro device (mesh), Settings → Zeus → "Tailscale fallback" e abra a porta 2223 no Tailscale do Mac canônico.

## Verificação rápida

Cmd+P:

- `Zeus: probe HTTP daemon` → `{status: ok, fm_available: true, ...}` — daemon respondendo
- `Zeus: status do daemon HTTP` → `ALIVE (spawned by plugin) — http://127.0.0.1:2223`
- `Zeus: buscar` → modal abre, digita 2+ letras

## Troubleshooting

| Sintoma | Causa | Correção |
|---|---|---|
| `daemon: DEAD (no-binary)` | `bin/ZeusDaemonMac` ausente do zip extraído | Re-baixe o release; confira que `bin/ZeusDaemonMac` está presente e executável |
| `daemon: DEAD (spawn-error)` com mensagem do Gatekeeper | Quarantine bit não removido | `xattr -d com.apple.quarantine <vault>/.obsidian/plugins/zeus/bin/ZeusDaemonMac` (plugin tenta automaticamente; falha apenas se permissão bloqueada) |
| `fm_available: false` no `/v1/health` | Apple Intelligence não ativado ou macOS < 26 | System Settings → Apple Intelligence & Siri → habilitar; aguardar download dos modelos |
| `pt-BR retorna texto vazio` em transcribe | Speech asset pt-BR não instalado | System Settings → General → Language & Region → adicionar pt-BR e usar Siri/Dictation 1x (asset baixa silenciosamente) |
| Indexação inicial lenta | Vault grande + cold start FM (~30s primeira chamada) | Esperar; subsequentes são instantâneas (cache SHA) |

## Maintainer — regenerar `bin/ZeusDaemonMac`

Após alterar `daemon/Sources/ZeusDaemonMac/*.swift`:

```
node scripts/build-release.mjs
```

Roda `swift build -c release`, copia para `bin/ZeusDaemonMac`, codesign adhoc, strip quarantine, e rebuilda `main.js` via esbuild. Commit.

## Desinstalação

1. Settings → Community plugins → desabilite Zeus.
2. Delete `<vault>/.obsidian/plugins/zeus/` (inclui o daemon binário — não polui outros plugins).
3. Daemon spawned é morto no `onunload`; LaunchAgent (se você instalou separado) sobrevive — `launchctl bootout gui/$UID/com.maiocchi.zeusdaemon`.
