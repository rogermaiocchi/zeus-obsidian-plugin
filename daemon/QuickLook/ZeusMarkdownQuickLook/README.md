---
tipo: referencia
criado: 2026-05-20
atualizado: 2026-05-20
status: ativo
---

# ZeusMarkdownQuickLook

Companion macOS Quick Look generator do plugin Zeus para Obsidian. Renderiza preview HTML rico com tokens Anthropic (Orange `#d97757`, Lora serif, Poppins headings) ao apertar **SPACE** em um arquivo `.md` no Finder ou Spotlight. Mostra frontmatter visível com chips de tags, wikilinks clicáveis, hierarquia de headings, blocos de código com syntax-class.

Complementa o [`ZeusMarkdownImporter`](../../MDImporters/ZeusMarkdownImporter/) do daemon — o importer indexa metadados no Spotlight; este Quick Look renderiza o conteúdo na pré-visualização.

## Status — depreciação de QLGenerator

> [!warning] Sonoma+ deprecou QLGenerator legacy
> A partir de macOS 14 (Sonoma), Apple recomenda [`QLPreviewExtension`](https://developer.apple.com/documentation/quicklook/qlpreviewingcontroller) (app extension embarcada num host `.app`). O caminho legacy (CFPlugIn `.qlgenerator` em `~/Library/QuickLook/`) continua **funcional** mas marcado deprecated. Esta implementação usa o caminho legacy por dois motivos:
>
> 1. Distribuição standalone — não exige host `.app` empacotado.
> 2. Compatibilidade desde macOS 10.15 (Catalina) até a versão atual.
>
> Quando Apple efetivamente remover o suporte, migrar para `QLPreviewExtension` empacotado dentro do binário do daemon Swift (`ZeusDaemonMac`).

## Build

Requisitos: Xcode Command Line Tools (`xcode-select --install`). **Não exige** Xcode IDE completo.

```bash
cd daemon/QuickLook/ZeusMarkdownQuickLook
make build
```

Artefato: `build/ZeusMarkdownQuickLook.qlgenerator/` — bundle CFPlugIn universal (`arm64` + `x86_64`).

### Smoke test (sem instalar)

```bash
make smoke   # dry-run da compilação + plutil -lint Info.plist
make lint    # só o plutil
```

## Install

```bash
make install
```

Copia o bundle para `~/Library/QuickLook/` e roda `qlmanage -r` + `qlmanage -r cache` para forçar a Quick Look daemon a reler generators.

### Verify

```bash
make verify
# Equivalente manual:
qlmanage -m generators | grep -i zeus
```

Preview rápido sem abrir o Finder:

```bash
qlmanage -p /caminho/para/nota.md
qlmanage -t /caminho/para/nota.md -s 512   # thumbnail 512x512
```

## Uninstall

```bash
make uninstall
# Equivalente manual:
rm -rf ~/Library/QuickLook/ZeusMarkdownQuickLook.qlgenerator
qlmanage -r
qlmanage -r cache
killall Finder    # se ícones antigos persistirem
```

## Layout do bundle

```
ZeusMarkdownQuickLook.qlgenerator/
└── Contents/
    ├── Info.plist                  # CFPlugInFactories + LSItemContentTypes
    └── MacOS/
        └── ZeusMarkdownQuickLook   # binário bundle (universal)
```

## Pipeline de renderização

1. Quick Look daemon detecta UTI `net.daringfireball.markdown` (alias: `public.markdown`).
2. Chama `QuickLookGeneratorPluginFactory` (em `main.c`) — retorna instância CFPlugIn.
3. Para preview (SPACE) — invoca `GeneratePreviewForURL`:
   - Lê arquivo UTF-8 (fallback Latin-1) com cap em 256 KB.
   - Split frontmatter `---...---` → YAML mínimo parseado em dicionário.
   - Body renderizado para HTML (subset: H1-H6, **bold**, *italic*, `code`, listas, blockquote, code blocks ```` ``` ````, `[[wikilinks]]`, `[links](url)`).
   - CSS embutido com tokens Anthropic. Wikilinks viram `obsidian://open?file=…` clicáveis.
4. Para thumbnail (Finder Cover Flow / Spotlight) — `GenerateThumbnailForURL`:
   - Extrai primeiro H1 + primeiro parágrafo.
   - Renderiza via `NSImage` com badge "Z" laranja no canto.

## Caveats

- **Privacy gate**. Este generator roda totalmente em-processo dentro da QL daemon do usuário; não faz IO de rede, não escreve em disco fora do bundle. Apropriado para conteúdo `sigiloso` (vault Clientes).
- **Performance**. Alvo <50ms preview, <30ms thumbnail. Arquivos >256 KB são truncados com aviso visual.
- **Subset Markdown**. Implementação intencionalmente mínima (~250 LOC de parser) — não pretende reproduzir Obsidian Live Preview. Para fidelidade completa, abrir no Obsidian.
- **Tabelas, callouts, MathJax, mermaid**. Não renderizados — preview indica conteúdo presente mas mostra como texto.

## Cross-referências do vault

- [[../../README.md|Zeus daemon README]]
- [[../../MDImporters/ZeusMarkdownImporter/README.md|Spotlight md importer]]
- [[../../../docs/ADR-007-QuickLook-Markdown-Preview.md|ADR-007]]
