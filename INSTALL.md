# Zeus — Instalação

## Pré-requisitos

- macOS 26.0+ (Sequoia / Tahoe) — FoundationModels requer macOS 15.1+ e Apple Silicon
- Swift 6.0+ (vem com Xcode Command Line Tools)
- Obsidian 1.5+

## Passo 1 — Binary `afm`

O plugin precisa de um binary `afm` (Apple Foundation Models CLI). Três caminhos:

### Opção A — Bundled em `bin/` (recomendado para distribuição)

Se você já tem `metafm` compilado no Metassistema:

```bash
cd <plugin-dir>
bash scripts/install-afm.sh
```

Isso copia `metafm` do `Metassistema/50_Ferramentas/apple-intelligence/.build/release/metafm` para `bin/afm` no plugin dir.

### Opção B — Global `~/.local/bin/metafm` (fallback automático)

Se você já tem `metafm` em `~/.local/bin/`, o plugin detecta automaticamente — não precisa fazer nada.

### Opção C — Custom path

Settings → Zeus → afm binary path → digite o caminho absoluto.

## Passo 2 — Ativação

1. Copie a pasta `zeus/` para `<seu-vault>/.obsidian/plugins/`
2. Reinicie Obsidian (Cmd+Q + reabrir)
3. Settings → Community plugins → habilite "Zeus — Apple-native Search & Connections"
4. Cmd+P → `Zeus: reindexar vault completo` (primeira indexação)

## Passo 3 — Validação

Cmd+P → `Zeus: buscar` — deve abrir o modal de busca. Digite duas letras para ativar.

Console (Cmd+Opt+I) deve mostrar:
```
[zeus] loaded v1.4.3 — Apple-native search & connections
[zeus] afm binary resolved: /path/to/afm
```

## Cross-device (iPhone / iPad)

1. Vault deve estar em iCloud Drive (`~/Library/Mobile Documents/iCloud~md~obsidian/<vault>/`)
2. Plugin instalado no Mac propaga via iCloud (`.obsidian/plugins/zeus/` sincroniza)
3. No iPhone: Obsidian → Settings → Community plugins → ative Zeus
4. iOS plugin lê `data/embeddings.jsonl` pré-computado pelo Mac
5. Busca em iOS usa fallback substring (sem afm); Smart View mostra cosine neighbors

## v0.6 — Mac daemon (Aegis-pattern HTTP, ADR-018)

Para eliminar cold start ~30s e ter HyDE em ~100ms, instale o `ZeusDaemonMac` no Mac mini/MacBook:

```bash
cd /Users/rogermaiocchi/Metassistema/50_Ferramentas/apple-intelligence/ProjetoAegis
./scripts/install-mac-daemon.sh
```

Isso:
1. Rebuild via `swift build -c release --product ZeusDaemonMac`
2. Copia binary para `~/.local/bin/zeusdaemon-mac`
3. Instala LaunchAgent em `~/Library/LaunchAgents/com.maiocchi.zeusdaemon.plist`
4. `launchctl bootstrap gui/$(id -u)` + `enable`
5. Verifica via `curl http://127.0.0.1:2223/v1/health`

Logs: `/tmp/zeusdaemon.out.log` + `/tmp/zeusdaemon.err.log`

Stop: `launchctl bootout gui/$(id -u)/com.maiocchi.zeusdaemon`

Após o daemon rodar:
1. Obsidian Settings → Zeus → ative **"Prefer daemon over child_process"**
2. Cmd+P → `Zeus: probe HTTP daemon` deve reportar `{status: ok, platform: macOS, nl_available: true, vision_available: true, fm_available: true}`
3. HyDE queries agora respondem em ~100ms (vs ~30s antes)

### v0.6 — iOS daemon (AegisDaemon HTTP extension)

Já implementado no projeto Aegis (`Sources/AegisDaemon/AegisHTTPServer.swift` + `AegisHTTPHandlers.swift`). 

**Status atual**: iOS xcodebuild bate em "multiple resources named 'PrivacyInfo.xcprivacy' in target 'MetassistemaAgent'" — colisão SwiftPM por adicionar ZeusDaemonMac target. Para resolver:

```bash
# Opção 1 — remover duplicata de PrivacyInfo.xcprivacy nos targets sobrepostos
find ProjetoAegis -name PrivacyInfo.xcprivacy  # ver onde está duplicado
# remover ou mover para target compartilhado

# Opção 2 — separar Mac target em Package.swift próprio
# (ZeusDaemonMac fica em SwiftPM isolado, MetassistemaApp iOS no .xcworkspace original)
```

Após corrigir, abra `MetassistemaApp.xcworkspace` no Xcode 26+, conecte iPhone via USB, Cmd+R. Daemon roda dentro do app — endpoints disponíveis em `http://127.0.0.1:2223/v1/{embed,enrich,agent,ocr,health}`.

### v0.6 — Fase D consolidada (AegisClaudeAgent on-device)

`AegisClaudeAgent.swift` foi refatorado para usar **FoundationModels.LanguageModelSession** em vez de `api.anthropic.com` remoto. Detalhes:
- `SystemLanguageModel.default.availability` check com fallback message
- ReAct loop em Swift via parsing de `TOOL_CALL: <name> {json}` markers no output do modelo
- 13 ferramentas nativas preservadas (read_file, write_file, list_dir, spotlight_search, calendar_query, contacts_search, photos_search, health_read, reminders_query, device_audit, send_notification, configurator_cmd, aegis_cmd)
- `claude.key` (Anthropic API key) e variável de ambiente `ANTHROPIC_API_KEY` não são mais usadas — pode deletar
- Build iOS 26.4 SDK: **BUILD SUCCEEDED** (após corrigir issue PrivacyInfo do Mac target)

## Troubleshooting

**"afm binary resolved: metafm" mas comandos falham:**
Settings → Zeus → afm binary path → coloque caminho absoluto explícito.

**"Exceeded model context window size":**
Limitação 4096 tokens do FoundationModels. Notas grandes/vault com muitos folders estouram. Mensagem aparece quando `enrich`/`agent`/`graph-extract` é chamado. Não afeta search principal (cosine).

**Indexação muito lenta:**
- Primeira run de embedding em vault grande pode levar minutos (cold start + N×batch)
- Subsequentes são instantâneas (cache por SHA)
- Reindex completo: Cmd+P → `Zeus: reindexar vault completo`

**Console erro `spawn ENOENT`:**
Path do `afm` errado. Settings → Zeus → afm binary path → fixar.

## Desinstalação

1. Settings → Community plugins → desabilite Zeus
2. Delete pasta `<vault>/.obsidian/plugins/zeus/`
3. Cache em `data/` é deletado junto (não polui outros plugins)
