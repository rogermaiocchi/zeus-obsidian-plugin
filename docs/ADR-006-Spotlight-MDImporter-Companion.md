# ADR-006 — Spotlight MDImporter como companheiro do CSSearchableIndex

- **Data:** 2026-05-20
- **Status:** aceito — materializa item diferido do brainstorm v1.7.
- **Origem:** sugestão Codex v1.7.1+v1.8.0; brainstorm 0% pendência (v1.8.1).
- **Companheiro de:** ADR sobre CSSearchableIndex (v1.7) que adicionou `POST /v1/spotlight/index` ao daemon Swift.
- **Não-objetivo:** substituir o pipeline `CSSearchableIndex` existente. As duas integrações coexistem.

## 1. Contexto

A v1.7 do plugin Zeus já fala com `CSSearchableIndex` via o daemon Swift
(`zeusdaemon-mac` → `POST /v1/spotlight/index`). Esse pipeline indexa itens
**internos** do aplicativo — entradas que abrem com deep-link `zeus://...`,
controladas pelo plugin (notas, comandos, históricos selecionados).

Esse pipeline tem três limites estruturais:

1. **Escopo de app.** `CSSearchableIndex` adiciona resultados na seção
   *Aplicações/Sugestões* do Spotlight. Resultados não aparecem ao filtrar
   por “arquivos `.md`”, não casam com cláusulas `kMDItem*` em `mdfind`, e
   não são listados como “documentos” — são entradas separadas que abrem o
   Obsidian via URL scheme.
2. **Cobertura parcial.** Só indexa o que o plugin explicitamente envia. As
   ~10⁵ notas espalhadas pelos quatro vaults canônicos (Metassistema,
   Estudo, Escritório, Clientes) **não** entram automaticamente — o plugin
   precisaria varrer cada arquivo e fazer chamada por item.
3. **Dependência de daemon.** Se `zeusdaemon-mac` não está rodando, o índice
   não se atualiza. Notas editadas fora do Obsidian (Vim, VSCode, `nvim`,
   apps mobile que sincronizam por arquivo) ficam desatualizadas.

O Spotlight nativo já lê `.md` como texto puro via o importer
`MarkdownImporter` (público da Apple, ships with macOS). Esse importer
**ignora frontmatter YAML inteiramente** — não há nada nele que saiba o que
é `tipo: adr` ou `status: ativo` ou `tags: [zeus, doutrina]`. O resultado:
`mdfind` acha notas por substring no corpo, mas não por metadado semântico.

## 2. Decisão

Adicionar um **`.mdimporter` customizado** (`ZeusMarkdownImporter`) ao
diretório `daemon/MDImporters/`. O bundle é instalado em
`~/Library/Spotlight/` via `make install` e é registrado por `mdimport -r`.

A partir daí, qualquer `.md` no disco que o Spotlight indexa passa pelo
nosso extractor, que popula `kMDItemKeywords`, `kMDItemTitle`,
`kMDItemAuthors`, `kMDItemDescription` a partir do frontmatter YAML e da
estrutura do corpo (H1/H2/H3, `[[wikilinks]]`, inline `#tags`).

As duas integrações coexistem por design:

| Camada | Escopo | Gatilho | Vive em |
|---|---|---|---|
| `CSSearchableIndex` (v1.7) | App-scoped, deep-link `zeus://` | Plugin chama daemon explicitamente | `daemon/Sources/ZeusDaemonMac/` |
| `.mdimporter` (v1.7.1+) | Filesystem-wide, qualquer `.md` no disco | Spotlight chama o importer ao escanear arquivos | `daemon/MDImporters/ZeusMarkdownImporter/` |

## 3. Alternativas consideradas

### 3.1 Só `CSSearchableIndex` (estado v1.7)

**Rejeitado.** Cobre só o que o plugin envia; deixa notas editadas fora do
Obsidian invisíveis para Spotlight semântico; depende do daemon rodando para
manter o índice fresco.

### 3.2 Só `mdimport` via CLI batch periódico

**Rejeitado.** O `mdimport` CLI indexa usando os importers já instalados —
ele **não cria** o entendimento de frontmatter sozinho. Sem o nosso bundle,
rodar `mdimport file.md` mil vezes não extrai uma única `tag:`. A CLI é
ferramenta de gatilho, não de parser.

### 3.3 Sidecar `.metadata.json` por nota

**Rejeitado.** Exigiria reescrever pelo plugin um arquivo paralelo a cada
save (ruído no git diff, conflito com mobile/iCloud sync, falha silenciosa
quando o usuário edita fora do plugin). Spotlight, além disso, não consome
sidecars — só extrai do arquivo que ele indexa.

### 3.4 `mdimporter` substitui `CSSearchableIndex`

**Rejeitado.** O importer **não cria itens deep-linkáveis**. Spotlight abre
arquivos `.md` no editor padrão do sistema (Finder → Preview / TextEdit),
não no Obsidian. O fluxo deep-link `zeus://open?path=...` continua exigindo
`CSSearchableIndex` ou um handler de URL scheme separado.

## 4. Consequências

### 4.1 Positivas

- Usuário instala o bundle **uma única vez** (`make install`). Não há
  componente em execução contínua — Spotlight chama o importer sob demanda.
- `mdfind 'kMDItemKeywords == "tipo:adr"'` passa a listar todas as ADRs em
  qualquer vault, instantaneamente, mesmo sem o Obsidian aberto.
- Notas editadas em editores externos (Vim, VSCode, `nvim`, app mobile
  syncado via iCloud) entram no índice semântico automaticamente.
- Custo zero em runtime do plugin — não acrescenta requisição ao daemon, não
  amplia a superfície de ataque do HTTP local.
- `CSSearchableIndex` (v1.7) é estritamente opcional para quem quer apenas
  busca filesystem-wide; vira opt-in via comando do plugin.

### 4.2 Negativas

- Primeira indexação é lenta (vários minutos para 10⁵ notas). Documentado em
  `daemon/MDImporters/ZeusMarkdownImporter/README.md` (seção *Force reindex*).
- Sem notarização, o bundle só roda na máquina onde foi compilado. Para
  distribuir a outros aparelhos, exige Apple Developer ID + notarização —
  fora do escopo desta ADR.
- O parser YAML é deliberadamente mínimo (scalars + listas inline + listas
  em bloco). Notas com mapas aninhados no frontmatter têm metadado
  parcialmente extraído. Trade-off aceito: Spotlight só consome atributos
  planos de qualquer jeito.

### 4.3 Operacionais

- O bundle vive em `daemon/MDImporters/ZeusMarkdownImporter/`, **fora** de
  `daemon/Sources/`. Não é compilado pelo `swift build` do daemon principal —
  Makefile próprio, build independente, instalação manual.
- `manifest.json` e `package.json` do plugin Obsidian permanecem intactos —
  o importer não é JavaScript e não muda o bundle do plugin.
- A `CHANGELOG.md` registrará na próxima release (v1.7.1 ou v1.8.x) o item
  *“companion Spotlight `.mdimporter` para `.md` files”*.

## 5. Privacy gate (CORA non-negotiable)

O importer **roda local**. Lê o `.md`, popula atributos `kMDItem*` no índice
Spotlight da máquina, retorna. Frontmatter e corpo não saem do disco; não há
chamada HTTP, não há LLM, não há sync remoto.

Notas em `Clientes/**` (`sigiloso`) entram no índice Spotlight local — mesma
fronteira de confiança do Finder. Quem pode listar arquivos do `~/Clientes/`
já podia ler o conteúdo deles; o importer apenas adiciona facetas de busca
sobre a mesma fronteira. Privacy gate respeitada por construção.

## 6. Validação

- Build local: `make verify && make bundle` — produz
  `build/ZeusMarkdownImporter.mdimporter/` com `Info.plist` válido
  (`plutil -lint` passa) e binário universal arm64+x86_64.
- Smoke pós-install: `mdimport -L | grep -i zeus` mostra o importer; `mdimport
  -d4 ~/Metassistema/Areas/...alguma-nota.md` despeja o dicionário
  `kMDItem*` com `tipo:`, `status:`, headings, wikilinks visíveis.
- Smoke de busca: `mdfind 'kMDItemKeywords == "tipo:adr"'` lista esta própria
  ADR + outras ADRs do vault Metassistema.
