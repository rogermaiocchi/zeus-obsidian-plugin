---
tipo: adr
criado: 2026-05-20
atualizado: 2026-05-20
status: ativo
adr_number: 007
adr_title: Quick Look generator companion para preview de .md
---

# ADR-007 — Quick Look Markdown Preview

## Contexto

O plugin Zeus já fornece um Spotlight Markdown Importer (`daemon/MDImporters/ZeusMarkdownImporter`) que indexa metadados (frontmatter, tags, headings) para busca de sistema. Falta o complemento natural: quando o usuário encontra um `.md` no Finder ou nos resultados do Spotlight e aperta `SPACE`, a pré-visualização atual do macOS mostra apenas texto cru — sem frontmatter destacado, sem wikilinks clicáveis, sem hierarquia de headings, sem identidade visual do vault.

Macropolítica do projeto exige rastreabilidade local-first (`Clientes/**` é `sigiloso` por default — vide `rules/juridico.md`), o que veta usar serviços externos para renderização. A solução precisa ser nativa, in-process, sem rede.

### Sinais e fatos

1. macOS 10.15+ aceita generators Quick Look entregues como `.qlgenerator` (CFPlugIn) em `~/Library/QuickLook/`. API documentada em [Quick Look Programming Guide](https://developer.apple.com/library/archive/documentation/UserExperience/Conceptual/Quicklook_Programming_Guide/).
2. macOS 14 (Sonoma) marcou `QLGenerator` como deprecated em favor de `QLPreviewExtension` (app extension embarcada em host `.app`). O caminho legacy **continua funcional** em todas as versões pós-Sonoma testadas até esta data; deprecation warning não impede instalação.
3. O daemon Swift do Zeus (`ZeusDaemonMac`) já existe como host potencial para uma `QLPreviewExtension` futura — mas adicionar uma app extension exige assinatura de código e empacotamento que hoje o repositório não tem.
4. Implementações de Quick Look em Markdown existentes (e.g. [QLMarkdown](https://github.com/sbarex/QLMarkdown), [qlmarkdown](https://github.com/toland/qlmarkdown)) confirmam o caminho legacy como viável, sem fricção crítica.

## Decisão

**Ship companion source-only `.qlgenerator` legacy.** O maintainer compila e instala manualmente via `make install` no diretório `daemon/QuickLook/ZeusMarkdownQuickLook/`. Não distribuímos binário pré-compilado nesta versão.

### Alternativas consideradas

| Alternativa | Vantagem | Veto |
| --- | --- | --- |
| **Preview built-in do macOS** (status quo) | Zero código | Sem frontmatter visível, wikilinks como texto, sem identidade visual do vault — falha o requisito |
| **QLPreviewExtension moderna** (Sonoma+) | API atual, sem deprecation warning | Exige host `.app` assinado; o daemon Swift hoje não é distribuído como `.app` empacotado. Bloqueia adoção rápida |
| **Servidor HTTP local + abrir Safari no SPACE** | Renderização rica via Obsidian Live Preview real | Quebra contrato Quick Look (não é preview in-line); requer daemon HTTP persistente; expõe risco de privacy gate |
| **Distribuir binário pré-compilado** | UX zero-fricção | Exige notarização Apple Developer ID; fora do escopo atual do repositório |

Decisão pela alternativa source-only de menor surface de risco com maior cobertura de versões macOS.

## Consequências

### Positivas

- Usuário aperta `SPACE` em `.md` no Finder ou no Spotlight result e vê preview HTML com:
  - Frontmatter em header destacado (chips coloridos para `tags`, par chave-valor para `tipo`, `status`, `criado`, `atualizado`, `privacidade`).
  - Wikilinks `[[nota]]` clicáveis via `obsidian://open?file=…` — abre direto no Obsidian.
  - Hierarquia de headings com borda Anthropic Orange no H1, gradação tipográfica Poppins.
  - Code blocks com `pre.zeus-code` em fundo escuro (paleta Anthropic Dark `#141413`).
  - Footer com nome do arquivo + assinatura "Zeus Markdown Quick Look".
- Thumbnail no Finder Cover Flow / Spotlight result mostra primeiro H1 + primeiro parágrafo + badge "Z" laranja — identifica visualmente arquivos do vault.
- Privacy gate respeitada — generator roda in-process dentro da QL daemon do usuário, sem rede, sem IO fora do bundle.
- Performance — alvo <50ms preview, <30ms thumbnail. Arquivos >256 KB truncados graciosamente com aviso.

### Negativas

- Maintainer compila e instala manualmente (`make install`) — não há flow automatizado no `release.sh` ainda.
- Deprecation warning em Sonoma+ ao registrar o generator — informacional, sem impacto funcional.
- Parser Markdown intencionalmente mínimo (~250 LOC) — não renderiza tabelas, callouts Obsidian, MathJax, mermaid. Aceitável: para fidelidade completa o usuário abre no Obsidian.
- Aumenta a superfície de manutenção: três linguagens convivem no daemon (Swift / ObjC-C / shell).

### Migração futura — gatilho de escalada

Migrar para `QLPreviewExtension` quando **2 dos 3** ocorrerem:

1. Apple anuncia data definitiva de remoção do caminho legacy.
2. `ZeusDaemonMac` for empacotado como `.app` assinado (LaunchAgent + bundle).
3. Logs de usuário reportarem que Sonoma+ bloqueou o generator legacy.

Até lá, a implementação atual atende o requisito original sem dívida técnica relevante.

## Aderência

- **CORA**: Cynefin **Complicated** (engenharia de plataforma com APIs conhecidas), privacy `interno` (código aberto), tier **2** (Sonnet executou; Opus revisou contrato e ADR).
- **Zeus**: nível 3 — geração de código standalone delegada; Opus retomou para enquadramento arquitetural e ADR.
- **Stack canônica (ADR-013)**: respeitada — Swift continua linguagem primária do daemon; ObjC/C aqui é restrita ao boundary obrigatório do CFPlugIn macOS (não há alternativa Swift idiomática para Carbon-style factories).

## Cross-referências

- [[../daemon/QuickLook/ZeusMarkdownQuickLook/README.md|README do generator]]
- [[../daemon/MDImporters/ZeusMarkdownImporter/README.md|Spotlight md importer companion]]
- [[../daemon/README.md|Daemon overall README]]
- [Quick Look Programming Guide (Apple, archive)](https://developer.apple.com/library/archive/documentation/UserExperience/Conceptual/Quicklook_Programming_Guide/)
- [QLPreviewExtension docs (Sonoma+ path)](https://developer.apple.com/documentation/quicklook/qlpreviewingcontroller)
