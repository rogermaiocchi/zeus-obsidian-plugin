---
tipo: adr
criado: 2026-05-20
atualizado: 2026-05-20
status: ativo
adr_number: 008
adr_title: Leiden communities — port JS enxuto sobre o multiplex (sem Python runtime)
---

# ADR-008 — Leiden Communities (JS Port Enxuto)

## Contexto

O plugin Zeus implementou em v1.8 o grafo multiplex (`lib/multiplex-graph.js`) — 8 edge types entre notas (wikilink, backlink, entity_overlap, date_overlap, folder_path, semantic_cosine, spotlight_token_bm25, co_citation) persistidos em `data/multiplex.jsonl`. O passo natural seguinte é detectar comunidades sobre esse grafo para que o usuário ganhe agrupamentos automáticos do vault — clusters de notas que dialogam entre si independentemente da hierarquia de pastas.

A referência interna canônica (`~/Code/maiocchi-ia/skills/tripla-fusao/scripts/cluster.py`, 741 LOC Python) usa `igraph` + `leidenalg` (binding C do paper Traag et al. 2019). Trazer essa stack inteira para dentro de um plugin Obsidian que precisa rodar **idêntico em macOS Electron e iOS Capacitor** (vide ADR-018 — daemon HTTP Aegis-pattern) tem três problemas:

1. **iOS Capacitor não tem Python.** Plugin já degrada gracioso em iOS — sem child_process, sem spawn. Acoplar Leiden a um daemon HTTP introduz dependência de rede em uma operação que é puramente computacional sobre dados que o JS já tem na mão (`plugin.multiplex.edges`).
2. **`igraph`/`leidenalg` adicionam ~30 MB ao runtime daemon.** A relação custo/benefício em vault típico (<10k nós) não justifica, mesmo em Mac.
3. **Codex audit prévio v1.8 deferiu para v1.9** com a observação literal: "Eu faria um port JS determinístico com escopo explícito: local move + conectividade + agregação simples, sem prometer equivalência acadêmica perfeita".

### Sinais e fatos

1. Vault Zeus típico tem 1.500–8.000 notas (medições em `~/Estudo/`, `~/Metassistema/`, `~/Clientes/`). O grafo multiplex resultante tem 30k–200k arestas (8 tipos × O(N²) bounded). Ordem de grandeza onde Louvain JS puro converge em <2s.
2. O paper Traag et al. 2019 ("From Louvain to Leiden: guaranteeing well-connected communities") identifica **uma** contribuição central sobre Louvain: detectar e quebrar sub-comunidades **internamente desconectadas** (artefato comum do local move guloso). A *refinement phase* completa do paper agrega ganhos adicionais marginais em grafos pequenos.
3. A modularidade Q tem resolution limit conhecido (Fortunato & Barthélemy 2007). Para vault de até ~10k nós o problema é irrelevante; a partir daí, `resolution` > 1.0 mitiga.
4. SHA-compare pattern para escrita em frontmatter (`ZeusNativeGraphIntegration` v1.6.1, codex MED #1) já está estabilizado no plugin — reutilizável diretamente para propagar `zeus_community: NN` sem disparar loop `modify → write → modify`.

## Decisão

**Implementar `lib/leiden.js` em JS puro com escopo enxuto: local move + connectivity split + agregação recursiva + best-partition tracking.** RNG xorshift32 seedado para determinismo. Persistência em `data/communities.jsonl` (1 linha por nó). Propagação opcional ao frontmatter via `zeus_community:` (default OFF, opt-in via setting). Comandos manuais (`zeus-leiden-detect`, `zeus-leiden-stats`) e auto-run em sequência com multiplex auto-build.

### Algoritmo (~430 LOC efetivos)

1. **Construção do grafo singleplex weighted**: agrega arestas multiplex por par `(A,B)` somando pesos dos 8 edge types (multiplex → singleplex via soma — interpretação razoável quando os pesos `DEFAULT_WEIGHTS` já refletem "qualidade da evidência").
2. **Local move**: para cada nó (ordem embaralhada com seed), calcula ΔQ movendo para a comunidade de cada vizinho. Aplica o melhor. Itera até convergência (max 20 passes).
3. **Connectivity split** (contribuição Leiden): para cada comunidade, BFS interna. Sub-componentes desconexos viram comunidades separadas com novos IDs.
4. **Aggregation**: super-grafo onde cada comunidade vira super-nó. **Self-loop preserva grau intra-comunidade** (sem isso a modularidade do nível agregado fica errada — observação explícita do codex audit anterior).
5. **Recursão**: re-roda 2+3+4 até cap (10 níveis) ou modularidade parar de melhorar.
6. **Best-partition tracking**: retorna a partição com **maior Q observado em qualquer nível** — não a última. Níveis tardios podem regredir.

### Alternativas consideradas

| Alternativa | Vantagem | Veto |
| --- | --- | --- |
| **Trazer `igraph` + `leidenalg` para o daemon HTTP** | Fidelidade acadêmica ao paper Traag 2019 (refinement phase completo, multiplex modularity nativa) | iOS Capacitor não roda Python; daemon precisaria expor `/v1/community/detect`; +30 MB runtime; rede para algoritmo puramente computacional |
| **Louvain JS puro (sem connectivity split)** | Mais simples (~150 LOC) | Sofre do problema central do paper: comunidades internamente desconectadas. Saída piora visualmente no Graph View do Obsidian |
| **Leiden completo JS (refinement phase + multiplex Q)** | Fidelidade total | ~800–1200 LOC; ganho marginal em vault <10k nós; tempo de bug-hunt no port supera o tempo de uso real |
| **Não detectar comunidades** | Zero código | Multiplex sem comunidades é só evidência crua — o agrupamento é o produto pedido pelo usuário |

A decisão pelo **enxuto** captura ~80% do valor do paper (a contribuição central) com ~30% do código.

## Consequências

### Positivas

- Plugin permanece **runtime-only-JS** — roda idêntico em Mac e iOS, sem novo serviço, sem nova dependência nativa.
- Determinístico — mesma seed produz mesma partição. Reprodutibilidade entre dispositivos sincronizados via iCloud.
- Compatível com graph nativo Obsidian — `zeus_community: NN` no frontmatter pode ser lido por Graph View (color groups por property) ou Bases (group-by). UX já existente do Obsidian, sem código de visualização novo.
- Best-partition tracking evita regressão silenciosa em vaults onde a recursão piora Q (caso comum em grafos com hubs muito conectados).
- SHA-compare em `_leidenLastWritten` reaproveita o pattern v1.6.1 — sem loop de escrita.

### Negativas

- **NÃO é o Leiden canônico.** O refinement phase do paper (Traag 2019 §3) não está implementado. Em grafos onde o refinement gera ganho significativo (grafos com muitos hubs e sub-estruturas finas), a partição final ficará pior que `leidenalg` Python. Ganho de qualidade vs Louvain (connectivity split) está garantido; ganho vs Leiden full não.
- Modularidade tradicional (singleplex) em vez de modularidade multiplex (Mucha 2010). O grafo multiplex é colapsado para singleplex ponderado antes do algoritmo rodar.
- Resolution limit clássico aplica-se — para vaults gigantes (>10k notas) usuário precisa subir `leidenResolution` manualmente para evitar mega-comunidades.
- Sem garantia teórica de "well-connected communities" no sentido forte do paper (apenas no sentido mínimo: sem sub-componentes desconexos pós-split).
- Tempo de execução O(N·log N · L) por nível × L níveis — bound prático em vault típico, mas degrada em vault >10k nós (pode passar de 10s sem yield).

### Migração futura — gatilho de escalada

Migrar para Leiden canônico (refinement phase + multiplex modularity, possivelmente via daemon HTTP só no Mac) quando **2 dos 3** ocorrerem:

1. Vault típico do usuário ultrapassar 15k notas (medido via `plugin.app.vault.getMarkdownFiles().length`).
2. Usuário reportar comunidades "estranhas" (notas claramente desconectadas semanticamente agrupadas) em mais de 5 inspeções consecutivas via comando `zeus-leiden-stats`.
3. Necessidade de operar sobre multiplex modularity (somar Q por layer) emergir em outra parte do plugin — operar layers independentemente sem colapsar para singleplex.

Até lá a implementação enxuta atende o caso de uso real sem dívida arquitetural relevante.

## Aderência

- **CORA**: Cynefin **Complicated** (algoritmo conhecido, porta determinística), privacy `interno` (código aberto, opera só localmente sobre dados do vault — nenhum byte sai do disco), tier **2** (Sonnet executou o port; Opus enquadrou contrato e ADR).
- **Zeus**: nível 3 — porta de algoritmo conhecido delegada; Opus retomou para enquadramento arquitetural e decisão de escopo.
- **Stack canônica (ADR-013)**: respeitada — TypeScript/JS continua a linguagem do plugin runtime; nenhuma nova dependência nativa.
- **Privacy gate**: comunidades sobre `Clientes/**` são derivadas exclusivamente do grafo local (multiplex já obedece privacy gate em coleta). Persistência em `<vault>/data/communities.jsonl` herda o privacy do vault. Propagação ao frontmatter (`zeus_community: NN`) é numerica — não vaza conteúdo da nota.

## Cross-referências

- [[../lib/leiden.js|lib/leiden.js — implementação]]
- [[../lib/multiplex-graph.js|lib/multiplex-graph.js — fonte das arestas]]
- [[ADR-007-QuickLook-Markdown-Preview.md|ADR-007 — Quick Look (companion)]]
- [Traag, V. A., Waltman, L., & van Eck, N. J. (2019). From Louvain to Leiden: guaranteeing well-connected communities. *Scientific Reports*, 9, 5233.](https://doi.org/10.1038/s41598-019-41695-z)
- [Mucha et al. (2010). Community Structure in Time-Dependent, Multiscale, and Multiplex Networks. *Science*, 328(5980), 876–878.](https://doi.org/10.1126/science.1184819)
- [Fortunato, S., & Barthélemy, M. (2007). Resolution limit in community detection. *PNAS*, 104(1), 36–41.](https://doi.org/10.1073/pnas.0605965104)
