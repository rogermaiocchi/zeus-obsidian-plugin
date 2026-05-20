---
tipo: adr
criado: 2026-05-20
atualizado: 2026-05-20
status: ativo
adr_number: 009
adr_title: Spotlight keywords enriquecidos — 6 fontes além de concepts NLTagger
---

# ADR-009 — Spotlight Keywords Enriquecidos (CSSearchableItemAttributeSet.keywords)

## Contexto

O comando `zeus-spotlight-index` (introduzido em v1.7 junto com o endpoint daemon `/v1/spotlight/index`) monta um batch de `CSSearchableItem` e entrega ao `CSSearchableIndex` do macOS, expondo o vault ao Spotlight e a `mdfind`. A montagem original (v1.7 → v1.8.1) preenchia `kMDItemKeywords` exclusivamente a partir de `passport.concepts` — os conceitos atômicos extraídos por `NSLinguisticTagger` (NLTagger) durante o ciclo de passport build.

### Sinais e fatos

1. **`passport.concepts` é subexploited como única fonte de keywords.** O extrator NLTagger acerta substantivos próprios e termos técnicos densos, mas perde sinais que o autor (Roger) já escreveu explicitamente no frontmatter ou na estrutura da nota: `tags`, `aliases`, headings hierárquicos, taxonomia declarada (`zeus_domain`).
2. **`kMDItemKeywords` é um campo array sem limite teórico**, mas Spotlight degrada qualidade de ranking quando o set fica acima de ~50 termos (observação empírica: muitas keywords competem por relevância e o ranker prefere matches em `title`/`summary`).
3. **Codex brainstorm v1.8** apontou literalmente: "`CSSearchableItemAttributeSet.keywords` enriquecido com entities + tags + aliases + headings — `passport.concepts` sozinho subutiliza o que o vault já tem em estrutura declarada."
4. **`app.metadataCache.getFileCache(file)`** já expõe `frontmatter`, `headings`, `tags` sem custo — a Obsidian Vault API cacheia esses dados durante o boot. Coletar daí é O(1) por file, sem IO adicional.
5. **Inline `#tags` do body** (parsing direto via regex `#[\wÀ-ſ\-]+`) exigiria `await vault.cachedRead(file)` em N files — em vault de 5k+ notas, isso adiciona segundos ao comando que hoje é sub-segundo na coleta.

## Decisão

**Enriquecer `keywords` com union (dedup case-insensitive, cap 25) de 6 fontes**, todas baratas via `metadataCache`:

1. `passport.concepts` — conceitos atômicos NLTagger (fonte original v1.7).
2. **Frontmatter `tags`** — array OU string CSV. Sinal mais forte: o autor escolheu manualmente.
3. **Frontmatter `aliases`** — sinônimos que o autor declara explicitamente. Spotlight passa a achar a nota pelos seus apelidos canônicos.
4. **Top H1-H3 headings** — `cache.headings.filter(h => h.level <= 3).slice(0, 8)`. Estrutura semântica da nota. Cap em 8 headings para não dominar quando a nota é longa.
5. **Frontmatter `zeus_concepts`** — concepts propagados pelo passport e fixados no FM (campo opt-in já existente em notas mais "maturas" do vault).
6. **Frontmatter `zeus_domain`** — taxonomia declarada (array OU string). Sinal de classificação top-level.

### Filtro pós-coleta

- Drop nullable/undefined.
- Drop strings com `length < 2` (sufixos lixo de parsing CSV).
- Dedup **case-insensitive** (`Processo`, `processo`, `PROCESSO` colapsa em um).
- Cap em 25 keywords — primeiros 25 vencem (ordem de inserção das fontes: concepts > tags > aliases > headings > zeus_concepts > zeus_domain).

### Alternativas consideradas

| Alternativa | Vantagem | Veto |
| --- | --- | --- |
| **Manter v1.7 (só `passport.concepts`)** | Zero código novo | Subutiliza estrutura declarada do vault — Codex audit explícito |
| **Adicionar inline `#tags` via `cachedRead`** | Captura tags inline que não estão no FM | `await cachedRead()` em N files = O(N) IO; vault 5k notas vira segundos. Diferível para v2.x se houver demanda real |
| **Sem cap (keywords ilimitadas)** | Sem informação perdida | Spotlight degrada ranking acima de ~50; vault com headings longos satura |
| **Cap 12 (igual v1.7)** | Compatível com baseline | Limita o ganho — 6 fontes em 12 slots significa que aliases + headings ficam quase sempre fora |
| **Cap 50** | Folga maior | Acima de 25 a marginal cai e o sinal mais forte (concepts + tags) já está coberto |

A escolha do **cap 25** é o meio-termo entre "espaço para todas as 6 fontes contribuírem" e "ranker do Spotlight ainda diferencia bem".

## Consequências

### Positivas

- `mdfind "kMDItemKeywords == 'taxonomia-X'cdw"` passa a achar notas por **alias** (sinônimo declarado), **heading** (estrutura semântica), **tag manual** (intenção explícita do autor) — não só por concepts extraídos heuristicamente.
- Sem custo de IO adicional — `metadataCache` já está populado durante boot do Obsidian. Coleta continua O(1) por file.
- Compatível com daemon Swift atual — o handler `/v1/spotlight/index` aceita `keywords: [string]` genérico, sem mudança no schema.
- Log do Notice final agora reporta `avg N keywords` da batch, permitindo auditoria empírica do enriquecimento (esperado: avg ~12–18 em vault maduro com FM rico).

### Negativas / Tradeoffs

- Cap 25 significa que vaults com muitos headings + concepts longos perdem cauda. Solução: cap revisável em v2.x se métrica `avg keywords` saturar consistentemente em 25.
- Inline `#tags` do body **não** incluídos — autor que usa exclusivamente tags inline (sem replicar no FM) perde esse sinal. Aceito como tradeoff de latência. Workaround documentável: rodar reindex Zeus que migra inline tags pro FM (já existe comando separado).
- Headings podem ser frases longas (`## Como o STF aplica o princípio da proporcionalidade`) — viram keywords longas que o Spotlight indexa como token único. Não é problema técnico (CSSearchableItem aceita), mas o match fica menos provável que keywords curtas. Aceito.

### Métricas observáveis

- Notice final: `Zeus Spotlight: N items · avg M keywords · domain ...`. Valor de `M` é proxy direto do quão rico está o vault em estrutura declarada.
- `data/spotlight-state.json` continua persistindo apenas `count` + `domain` + `mode` (não mudou). Métricas detalhadas (distribuição de keywords por fonte) podem ser adicionadas em v2.x se necessário para debug.

## Implementação

- **Arquivo único**: `main.source.js` — callback do comando `zeus-spotlight-index` (~30 LOC novos dentro do loop `for (const f of files)`).
- **Sem mudança em `lib/`**: `zeus-http-client.spotlightIndex()` continua passando `items` opacos.
- **Sem mudança em `daemon/`**: handler Swift `/v1/spotlight/index` já é genérico sobre `keywords: [string]`.
- **Sem mudança em `manifest.json`**: campo `keywords` do CSSearchableItem não é interface exposta a usuário, é payload interno.

## Validação

1. `bun run build` — esbuild produz `main.js` sem erro.
2. `node --check main.source.js` — sintaxe válida.
3. `node scripts/zeus-doctor.mjs` — 7/7.
4. `node scripts/zeus-smoke.mjs` — 9/9.
5. **Teste empírico** (manual, fora desta entrega): após rodar `zeus-spotlight-index` em vault com notas que tenham `aliases:` no FM, executar `mdfind` pelo alias e confirmar match.

## Trabalhos relacionados

- **ADR-006** — Spotlight MDImporter Companion (escopo daemon).
- **ADR-007** — QuickLook Markdown Preview (UX adjacente).
- **Codex brainstorm v1.8** (não persistido em ADR formal; capturado neste documento como input direto na seção Contexto).
- **v2.x potencial** — inline `#tags` via streaming async cap (paralelizar `cachedRead` com `Promise.all` em lotes de 50, ou usar `dataview` index se disponível).
