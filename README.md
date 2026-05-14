# Zeus — Apple Ecosystem-native Search & Connections for Obsidian

> Substitui Omnisearch + Smart Connections com pipeline 100% Apple-native: Foundation Models, Vision, NaturalLanguage, CoreSpotlight. Indexação no Mac, leitura cross-device via iCloud.

## Convenção ecumênica de prefixos

| Prefixo | Apple Subsystem | Como o plugin usa |
|---|---|---|
| `afm` | Apple Foundation Models | binary CLI — embed, prompt, agent, enrich, graph-extract, classify, vision, ocr |
| `av` | Apple Vision | `av classify` (categorias), `av aesthetics`, `av landmarks` (faces), `av describe` (VLM) |
| `aocr` | Apple OCR | Vision `RecognizeTextRequest` + `--structured` (macOS 26+ layout-aware) |
| `anl` | Apple NaturalLanguage | `NLContextualEmbedding` 512-dim, on-device, 23 idiomas |
| `aia` | Apple Intelligence | reasoning camadas via `afm enrich` / `afm agent` / `afm graph-extract` |
| `acs` | Apple CoreSpotlight | metadata via `mdls` (EXIF, GPS, datas, kind, tags) |
| `acp` | Apple Cloud Private | Private Cloud Compute (reservado para v0.5+) |

## Pipeline multi-modal por tipo de arquivo

```
.md     → anl embed (512-dim) → cosine + exact-match boost
.pdf    → aocr --structured (layout-aware) → texto → anl embed
.png    ┐
.jpg    ├─ aocr (texto na imagem)
.heic   │  + av classify --top-n 8 (categorias visuais)
.jpeg   │  + av landmarks (contagem faces — sem face recognition)
.tiff   │  + acs/mdls (EXIF, GPS, Make/Model, Title, Description, Tags)
.bmp    ┘  → texto sintetizado → anl embed
```

## Camadas de reasoning (aia, opcionais)

- **Enrich** — `afm enrich <note>` invoca FoundationModels com 4 vault tools (`read_vault_note`, `list_folder`, `search_vault`, `get_frontmatter`) para descobrir links sugeridos + conexões explicadas. Limitação: janela 4096 tokens (notas grandes estouram).
- **Agent Q&A** — `afm agent` com padrões `react | plan-execute | reflexion`. Modal "Pergunte ao vault" para Q&A multi-turn.
- **Knowledge Graph** — `afm graph-extract` extrai nodes+edges schema-validated → render SVG modal.

## HyDE — Hypothetical Document Embedding (DISRUPTIVE)

Pattern de 2023 (Gao et al., [arXiv:2212.10496](https://arxiv.org/abs/2212.10496)) que bate vanilla query embedding em 10-20%:

1. User digita query `"como configurar tailscale para iPhone"`
2. `afm prompt` gera nota hipotética: `"Para configurar Tailscale no iOS você precisa..."`
3. Embeda a nota gerada (não a query crua)
4. Cosine vs vault — bridge query↔doc representation gap

Custo: +~30s de cold start por query (spawn fresh do FoundationModels). Default OFF. Habilite para queries abstratas/complexas via Settings → HyDE.

## Comandos (Cmd+P)

- `Zeus: buscar (Apple NLContextualEmbedding)`
- `Zeus: reindexar vault completo`
- `Zeus: abrir painel de conexões`
- `Zeus: enrich nota atual (FoundationModels)` ⚠️ exp
- `Zeus: knowledge graph da nota atual (FoundationModels)` ⚠️ exp
- `Zeus: perguntar ao vault (FoundationModels agent)` ⚠️ exp
- `Zeus: alternar HyDE query expansion`

## Cross-device (iCloud)

- **Mac mini / MacBook**: indexação + reasoning completos (via `afm` binary)
- **iPhone / iPad**: leitura read-only de `data/embeddings.jsonl` syncado via iCloud; busca semântica fallback para substring sem o `afm` binary (Capacitor sandbox iOS não tem child_process)

## Instalação

Ver [INSTALL.md](INSTALL.md).

## Estrutura

```
zeus/
├── manifest.json       Plugin manifest (Obsidian)
├── main.js             Plain ES2020 JS, sem build chain
├── styles.css          Claude-style minimalist, integra com Style Settings
├── README.md           Este arquivo
├── INSTALL.md          Setup do binary afm + ativação no Obsidian
├── LICENSE             MIT
├── .gitignore
├── bin/
│   └── .gitkeep        afm binary lives here when bundled (build via scripts/install-afm.sh)
├── scripts/
│   └── install-afm.sh  Compila metafm do Metassistema e copia como bin/afm
└── data/               Runtime — embeddings.jsonl, manifest.json, av-cache/, aocr-cache/, aia-enrich-cache/
    └── .gitignore      Ignora todo conteúdo de data/
```

## Versão

`0.4.0` — multi-modal Apple-native pipeline + HyDE + Knowledge Graph view + naming ecumênico.

## Roadmap aberto — Swift/Python/Rust helpers em `bin/`

O plugin é Mac developer-mode native — qualquer binary em `bin/` é descoberto e usado. Caminhos de evolução concretos:

### v0.5 — Cold-start zero (Swift)
`bin/afm-daemon` (Swift, ~150 LOC): mantém `LanguageModelSession` residente. Plugin envia queries via Unix socket. HyDE cai de ~30s para ~100ms. LaunchD agent autostart.

### v0.5 — Embedding 768-dim Apple-native (Swift + CoreML)
`bin/afm-embed-768` (Swift, ~80 LOC): carrega `multilingual-e5-base.mlmodelc` (768-dim via CoreML, convertido com `coremltools.converters.transformers`). Recebe texto via stdin, retorna 768-dim JSON. Plugin detecta e oferece como backend alternativo nas Settings.

### v0.5 — Multi-vector embedding
Pipeline: para cada doc → 3 embeddings (title via afm embed, body via afm embed, summary via afm summarize→embed). Cosine de query contra `max(3 scores)` ou `weighted_sum`. Cobertura efetiva 1536-dim sem precisar de modelo maior.

### v0.5 — Reranking via afm classify cross-encoder
Para top-K candidatos do cosine, chama `afm classify --options "highly_relevant,relevant,not_relevant"` em paralelo. Latência mitigada pelo daemon residente.

### v0.6 — MLX hidden states (Python)
`scripts/mlx-embed.py` (~50 LOC): usa `mlx_lm.load` + extract `hidden_states[-1]` de um modelo como `Qwen2-0.5B`. Embeddings 1024-dim, true on-device via MLX framework Apple. Plugin shell-out: `python3 scripts/mlx-embed.py`.

### v0.6 — `acp` Private Cloud Compute
Helper Swift que ativa Private Cloud Compute para queries que excedem janela 4K. Apple Intelligence routing: dispositivo decide local vs PCC, plugin entrega resposta.

### v0.7 — Audio pipeline (`asp` Apple Speech)
Para `.m4a/.wav` no vault: `afm speech` → transcript → embed. Voice memos viram índice searchable.

### Plugando seus helpers customizados

```json
// Settings → afm binary path
// ou via Settings → Custom embed bin (futuro)
{
  "afmPath": "",                          // auto-detect bundled bin/
  "customEmbed768Path": "bin/afm-embed-768"  // futuro v0.5
}
```

O plugin descobre qualquer binary em `bin/` que retorne JSON `{vectors, dim, model, count}`. Convenção mínima para integração.

### v0.7+ — Audio (`asp` Apple Speech) — voice memos `.m4a` para o pipeline de indexação

## Autoria

Roger Maiocchi · [maiocchi.adv.br](https://maiocchi.adv.br) · MIT License
