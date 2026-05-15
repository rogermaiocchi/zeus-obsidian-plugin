# Apple-Native Enhancement Roadmap — Zeus Plugin v1.3 → v1.5

> Roadmap derivado do estudo NotebookLM `aa48f2d1` (2026-05-15) com 12 fontes (Apple Developer docs + apple-fm-sdk GitHub + Private Cloud Compute + MLX + plugin READMEs internos). Detalhe expandido em `60_Operacao/Projetos-Zeus/ZEUS-022-Zeus-Plugin-Apple-Native-Enhancement.md` no vault Metassistema.

## Descoberta de base: `apple-fm-sdk` v0.1.1 (Apple Inc., Apache-2.0)

Python bindings via ctypes para o framework Swift `FoundationModels`. Já instalado em `/opt/homebrew/lib/python3.14/site-packages/apple_fm_sdk/`. Permite migrar partes do pipeline do plugin para um worker layer Python que roda em paralelo ao daemon Swift, sem duplicar responsabilidades.

API canônica:

- `LanguageModelSession(instructions, model, tools)` — sessão FM com instructions persistentes + tools registry, async `respond()` e `stream_response()`
- `Tool` abstract class — `arguments_schema: GenerationSchema` + `async call(args) -> str`
- `@generable` decorator — typed Python class → GenerationSchema (idiomático Apple)
- `GenerationGuide` / `guide()` — constraints sobre output (regex, ranges, enums)
- `GenerationOptions(sampling, temperature, maximum_response_tokens)` — sampling: greedy/random/top/probability_threshold/seed
- `SystemLanguageModel.is_available` — capability check on-device

## Domain Boundary Python ↔ Swift

**Regra de ouro**: Swift cuida da superfície interativa (real-time/runtime); Python cuida da superfície analítica (offline/batch).

| Camada | Responsabilidade |
|---|---|
| Daemon Swift (`ZeusDaemonMac` + `AegisDaemon`) | Loop HTTP de baixa latência, streaming UI ao Obsidian, OS-state APIs (CoreSpotlight, Vision OCR layout-aware, NSDataDetector) |
| Python workers (`apple-fm-sdk` + MLX) | Batch jobs offline (transcripts, geração sintética, fine-tune, regression eval); leem/escrevem `data/*.jsonl`; nunca chamam HTTP em real-time |

**Integração canônica**: `child_process.spawn` do plugin Obsidian (TS) chamando scripts Python em `bin/`. Reutiliza padrão `pluginRequire()` existente. Zero bridge HTTP nova entre Swift↔Python.

## v1.3 — Native Refinement & Opaque Media Unlocking (~2 semanas)

| Feature | Camada | Effort | Impacto |
|---|---|---|---|
| `afm-refine` (Writing Tools nativo, POST `/v1/afm/refine`) | Daemon Swift | S (~40 LOC) | Zero-cost rewrite/proofread; substitui Grammarly |
| `asp-transcribe` (SpeechAnalyzer + Transcriber + Detector VAD, POST `/v1/asp/transcribe`, `/v1/asp/vad`) | Daemon Swift | M (~120 LOC) | +200 voice memos searchable no PIA |
| `python-worker-layer` (`child_process.spawn` TS→Python com `apple-fm-sdk`) | Plugin TS + `bin/` | S (~50 LOC) | Desacopla batch do daemon SwiftNIO |

**KPIs**: cobertura ext audio ON; `/v1/afm/refine` < 1.5s no M2 Pro.

**Risks**: (1) memory leak buffers áudio → chunking + descarte forçado; (2) Python env quebrado → fallback gracioso TS; (3) PCC acidental → manter heurística `.off` default v1.2.0.

## v1.4 — Semantic Spine Upgrade & Python Batch Workers (~3-4 semanas)

| Feature | Camada | Effort | Impacto |
|---|---|---|---|
| `afm-embed-768` (`multilingual-e5-base.mlmodelc` substitui `NLContextualEmbedding` 512-dim) | Daemon Swift + CoreML | M (~80 LOC) | +15-20% recall PT-BR/EN |
| `mlx-classify` (cross-encoder reranker via MLX em `scripts/mlx_reranker.py`) | Python (MLX) | M (~100 LOC) | Filtro hard-negatives top-10 PIA |
| `batch-eval` (regressão de prompts via `apple-fm-sdk` + `@generable`) | Python | S (~60 LOC) | 100% automação CI; mede cold-start HyDE |

**KPIs**: MRR superior em 1.000 queries sintéticas; thermal stability M2 Pro.

**Risks**: (1) bloat 768-dim no LRU → FP16 sem int4 (~220MB cabe folgado); (2) reranker latência → mMiniLMv2 ~110MB, top-10 only; (3) `embeddings.jsonl` schema break no iOS → versionar + lazy migration AegisDaemon.

## v1.5 — Architectural Reorg & Tool-Calling Native Loop (~4-6 semanas)

| Feature | Camada | Effort | Impacto |
|---|---|---|---|
| `afm-agent-native` (Tool-calling Swift via protocolo `Tool` + `@Generable` macro, POST `/v2/agent`) | Daemon Swift | L (~250 LOC) | -40% latência HyDE + ciclo Q&A |
| `bg-index-scheduler` (`BGTaskScheduler` reindex noturno 10K+ notas) | Daemon Swift | L (~200 LOC) | Zero latência runtime percebida |
| `synthetic-finetuner` (geração off-line hard-negative pairs via `apple-fm-sdk` + `@generable`) | Python | M (~100 LOC) | Vocabulário jurídico custom |

**KPIs**: latência Q&A -30%+; zero thermal throttling reindex global.

**Risks**: (1) breaking change TS→Swift reflection loop → `/v1/agent` viva + `/v2/agent` migração gradual; (2) `BGTaskScheduler` Jetsam → lock files iCloud + checkpointing por nota; (3) tool calling recursivo → hard-limit `max 5 iterations` em `LanguageModelSession`.

## Modelos CoreML/MLX sugeridos

### Embeddings (spine)

| Modelo | Dim | Tamanho FP16 | Notas |
|---|---|---|---|
| `intfloat/multilingual-e5-base` ⭐ | 768 | ~220MB | 100+ idiomas; já no roadmap v0.5; converte bem CoreML; exige prefix `query:`/`passage:` |
| `BAAI/bge-m3` | 1024 | ~1.1GB | SOTA multilingual; suporta 8192 tokens; precisa MLX + int8 |
| `Qwen/Qwen2-0.5B` | 1024 | ~500MB | Leve via MLX; decoder-only → mean-pooling cuidadoso |

### Cross-encoder (reranker)

| Modelo | Tamanho | Notas |
|---|---|---|
| `cross-encoder/mmarco-mMiniLMv2-L6-H384-v1` ⭐ | ~110MB | mMARCO PT; pair com PIA passport summary (limite 512 tokens) |
| `BAAI/bge-reranker-v2-m3` | ~2.2GB | SOTA jurídica bilíngue; destilação ou int8 obrigatórias |

### Quantização

- **Embeddings**: FP16 sem int4. Int4 esmaga similaridade fina jurídica (perde "provida"/"improvida").
- **LLM agent/reasoning**: int8 ou int4 via `mlx.nn.quantize` — saída textual tolera bem.

## Pipeline `synthetic-finetuner` (v1.5 sketch)

```python
# bin/synthetic_finetuner.py
from apple_fm_sdk import LanguageModelSession, generable, guide
import json

@generable("Synthetic query+positive+hard-negative triplet")
class SyntheticPair:
    user_query: str = guide("Pergunta capciosa cuja resposta esteja no documento")
    positive_document: str = guide("Resposta extraída do documento")
    hard_negative_document: str = guide("Parágrafo que parece responder mas não responde")

async def gerar_pares(passport_jsonl_path: str, n_per_doc: int = 5):
    session = LanguageModelSession(
        instructions="Aja como advogado brasileiro. Gere pares sintéticos para fine-tune."
    )
    with open(passport_jsonl_path) as f:
        for line in f:
            passport = json.loads(line)
            for _ in range(n_per_doc):
                pair = await session.respond(passport["one_line_summary"], schema=SyntheticPair)
                yield pair
```

Exporta como Hugging Face Dataset → treina `SentenceTransformers` cross-encoder localmente, alinhado ao corpus do vault.

## Checklist next sprint (v1.3)

- [ ] `/v1/afm/refine` no `ZeusMacHTTPHandler.swift` — 3 modos (proofread/rewrite/simplify) via query param
- [ ] `/v1/asp/transcribe` — `SpeechAnalyzer` + `SpeechTranscriber` macOS 26+ — chunking + descarte
- [ ] `/v1/asp/vad` — `SpeechDetector` para skip de áudio < 5s
- [ ] Setup `bin/` Python worker — `child_process.spawn` no `main.js` + convenção stdout JSON
- [ ] Stub `bin/batch_eval.py` — print versão `apple-fm-sdk` para validar pipeline
- [ ] Settings UI — toggles "Refine on-device" e "Transcrever voice memos" (default ON)
- [ ] Status bar — contador `🎙️ N memos indexados`

## Referências

- NotebookLM source: `aa48f2d1-0383-4b53-96d6-f59e4ae63d63` — 12 fontes + 4 notas de análise
- Estudo expandido: `60_Operacao/Projetos-Zeus/ZEUS-022-*.md` no vault Metassistema
- Apple SDK: https://github.com/apple/python-apple-fm-sdk
- FoundationModels: https://developer.apple.com/documentation/foundationmodels
- Speech (SpeechAnalyzer): https://developer.apple.com/documentation/speech
- Translation: https://developer.apple.com/documentation/translation
- NaturalLanguage: https://developer.apple.com/documentation/naturallanguage
- CoreML: https://developer.apple.com/documentation/coreml
- MLX: https://ml-explore.github.io/mlx/build/html/index.html
- PCC: https://security.apple.com/blog/private-cloud-compute/
