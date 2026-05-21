# Design — Camada Qwen 2.5 3B (Apple Twin) — v1.15.0

- **Data:** 2026-05-21
- **Status:** implementado em v1.15.0 (migração de Gemma 4 E2B/E4B para Qwen 2.5 3B-Instruct 4-bit)
- **Substitui:** `2026-05-16-camada-gemma4-design.md` (Gemma 4 E2B/E4B descontinuado)
- **Razão da migração:** Gemma 4 exigia dois modelos distintos (E2B iPhone / E4B iPad); Qwen 2.5 3B único cobre todos os devices com melhor desempenho em português do Brasil.

## 1. Contexto e decisão

O motor generativo on-device do AegisDaemon iOS (para dispositivos sem Apple Intelligence) foi migrado de **Gemma 4 E2B/E4B** para **Qwen 2.5 3B-Instruct 4-bit**, via MLX Swift.

### Por que Qwen 2.5 3B?

| Critério | Gemma 4 E2B/E4B | Qwen 2.5 3B-Instruct 4-bit |
|----------|-----------------|---------------------------|
| Modelos necessários | 2 (iPhone vs iPad) | 1 (único para todos) |
| Tamanho total | E2B ~1.4 GB + E4B ~2.6 GB | ~1.8 GB |
| PT-BR (semântica, coesão, morfologia) | Médio | Alto (treinado em corpus multilíngue maior) |
| JSON determinístico | Bom | Excelente (stop token preciso `<\|im_end\|>`) |
| Janela de contexto | 8192 tokens (E4B) / 4096 (E2B) | 4096 tokens (suficiente para 7 tarefas) |
| RAM em A14 (iPad Air gen 4) | 2.6 GB (E4B) — margem apertada | 1.8 GB — confortável |
| Chat template | `<start_of_turn>` (Gemma) | ChatML `<\|im_start\|>` (Qwen) |

## 2. Domínio de treinamento (Fase A few-shot → Fase B LoRA)

O modelo é treinado/ajustado em:

**INCLUI:**
- Semântica do português do Brasil: léxico, morfologia (flexão verbal/nominal, formação de palavras), fonologia (tonicidade, sílabas), sintaxe (coordenação, subordinação, concordância), pragmática (implicaturas, pressuposições)
- Coesão e coerência textual: anáfora, catáfora, dêixis (anafórica, catafórica, exofórica), elipse, conjunções coesivas
- Engenharia de texto: parágrafo, tópico frasal, progressão temática, articulação argumentativa
- Métodos de organização do conhecimento: Feynman (compressão explicativa), Luhmann Zettelkasten (nós autônomos, wikilinks), Cornell (cue→summary→detail)
- Busca semântica: hash turbo quantico (SHA-256 exact, SimHash 128-bit), HyDE (Hypothetical Document Embeddings), expansão de query
- Integração Obsidian: grafo multiplex 8 edge-types, banco .base, passport index, embeddings NLContextualEmbedding

**EXCLUI:**
- Conteúdo jurídico ou previdenciário específico
- Domínios verticais que não sejam computação linguística + arquitetura de busca

## 3. Arquitetura

### 3.1 Implementação Swift

**`QwenProvider.swift`** — `MLXQwenRunner: MLXAppleTwinProviding`
- Template: ChatML (`<|im_start|>system\n...<|im_end|>`)
- Stop token: `<|im_end|>` (finaliza geração antes do max_tokens quando modelo fecha o turn)
- 7 métodos: summarize, refine, enrich, prompt, hyde, agentQuery, graphExtract
- Temperatura: 0.0 (determinístico)
- Budget térmico: nominal/fair=4096ctx, serious=1024ctx max180tkn, critical=recusa

**`AppleTwinSystemPrompt.swift`** — per-command system prompts:
- `forCommand(.summarize)` — Feynman compression, coesão referencial, prosa PT-BR
- `forCommand(.refine)` — revisão morfossintática, concordância, regência, coesão
- `forCommand(.enrich)` — Luhmann + Cornell, JSON estrito
- `forCommand(.prompt)` — geração técnica PT-BR, sem prolixidade
- `forCommand(.hyde)` — HyDE: doc hipotético para retrieval semântico
- `forCommand(.agent_query)` — RAG Q&A com anáfora entre fragmentos
- `forCommand(.graph_extract)` — extração de entidades/relações, Luhmann nós + Feynman `why`

**`FewShotLoader.renderTurnsQwen()`** — few-shot em ChatML (vs Gemma `<start_of_turn>`)

### 3.2 Bootstrap (MLXAppleTwinBootstrap.swift)

- FM disponível (iOS 26+ com Apple Intelligence) → twin não carregado
- FM indisponível → `MLXQwenRunner` (único modelo, sem distinção iPhone/iPad)
- ODR tag: `qwen-twin-v1.0` (vs `gemma-twin-v1.0`)
- Resource name: `zeus-qwen2.5-3b-instruct-4bit-v1.0` (prefixo zeus-)

### 3.3 Encapsulamento (regra v1.15.0)

Modelo distribuído como ODR (On-Demand Resource), salvo em:
`Application Support/Aegis/qwen-twin/zeus-qwen2.5-3b-instruct-4bit-v1.0/`

Prefixo `zeus-` aplicado ao diretório de pesos — auditabilidade e encapsulamento.
Sem fetch de CDN em runtime de inferência.

## 4. Fase A — few-shot stock (v1.0, sem treino)

Mesmos 7 pares curados por tarefa (`FewShotExamples/*.json`), capturados do FoundationModels do Mac mini. Reutilizados de Gemma com adaptação ao template ChatML via `renderTurnsQwen()`.

## 5. Fase B — destilação passiva LoRA PT-BR (roadmap)

Igual ao design Gemma (docs/superpowers/specs/2026-05-16-camada-gemma4-design.md §4), com:
- Gate: Mac mini + Tailscale + idle + AC
- Corpus: pares capturados de FoundationModels em tarefas reais de PT-BR text engineering
- Adapter: LoRA rank-8 sobre Qwen 2.5 3B-Instruct base
- ODR versioning: `qwen-twin-v1.1`, `v1.2`, etc.

## 6. Compatibilidade

O contrato de endpoint HTTP do AegisDaemon não muda. O `ZeusHttpClient` do plugin JS continua ignorante do modelo backend. A migração é transparente para o caller.

Gemma 4 (`MLXGemmaTwinRunner`) permanece no codebase para referência histórica e rollback de emergência — não é instanciado pelo bootstrap v1.15.0.
