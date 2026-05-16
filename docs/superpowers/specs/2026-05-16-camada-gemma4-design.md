# Design — Camada Gemma 4 do Zeus (Apple Twin)

- **Data:** 2026-05-16
- **Status:** estratégia Fase A/B refinada — execução delegada a um task em andamento.
- **Origem:** brainstorm `superpowers:brainstorming` (2026-05-16); revisado no mesmo dia com a reformulação Fase A/B do autor.
- **Estado de execução:** um task executa as duas partes — **Fase A end-to-end**, **Fase B esqueleto** (launchd plist + middleware de captura). Reporte previsto ao fechar a v1.0.0.

## 1. Contexto e objetivo

O Zeus é um plugin Obsidian com daemon nativo (`zeusdaemon-mac` nos Macs, `AegisDaemon` no iOS). As funções generativas — summarize, refine, enrich, prompt, hyde, agentQuery, graphExtract — dependem do Apple FoundationModels, presente nos Macs (macOS 26+) mas **ausente no iPhone 15 (A16) e no iPad Air gen 4 (A14)** — esses aparelhos não rodam Apple Intelligence (limite de hardware).

**Objetivo:** dar paridade generativa no iOS usando Gemma 4 on-device ("Apple Twin"), atrás da mesma interface, e fazer o Gemma imitar a Apple Intelligence — começando por few-shot e melhorando por destilação passiva.

**Não-objetivos:** substituir o FoundationModels nos Macs (seguem nativos); mexer em embeddings, Vision ou OCR — todos já nativos Apple nos 4 aparelhos. Esta camada é exclusivamente **IA generativa**.

## 2. Decisões

| # | Decisão |
|---|---|
| D1 | Gemma 4 on-device: **E2B no iPhone 15, E4B no iPad Air gen 4**. |
| D2 | Runtime: **MLX (mlx-swift)**, embarcado no `AegisDaemon` iOS. |
| D3 | Paridade: Gemma cobre as 7 tarefas generativas (summarize, refine, enrich, prompt, hyde, agentQuery, graphExtract). |
| D4 | Macs seguem no FoundationModels nativo. |
| D5 | Faseado: **Fase A** = few-shot (sem treino), sai como v1.0.0; **Fase B** = destilação passiva contínua (`AegisTwinTrainer`). |
| D6 | Abordagem: backend transparente atrás do contrato de endpoint. |

## 3. Arquitetura

Protocolo Swift `GenerativeProvider`, compartilhado entre os targets `ZeusDaemonMac` e `AegisDaemon`, com duas implementações:

- `FoundationModelsProvider` — envolve o Apple FoundationModels. Usado nos Macs.
- `GemmaProvider` — envolve MLX + Gemma 4. Usado no iOS.

Os endpoints HTTP do daemon chamam métodos do protocolo — agnósticos ao modelo. No bootstrap, o daemon detecta se o FoundationModels está disponível e instancia o provider correspondente. O `ZeusHttpClient` do plugin **não muda**: mesmo contrato HTTP, nunca sabe qual modelo respondeu.

### 3.1 `GenerativeProvider` (protocolo)

Um método por tarefa generativa:
`summarize`, `refine`, `enrich`, `prompt`, `hyde`, `agentQuery`, `graphExtract`.

### 3.2 `GemmaProvider`

- Carrega o Gemma 4 via mlx-swift no startup do `AegisDaemon` — **E2B no iPhone 15, E4B no iPad Air gen 4**.
- **Fase A (few-shot):** cada tarefa usa o system prompt canônico de `AppleTwinSystemPrompt.swift` + **3-5 pares curados manualmente** capturados do FoundationModels do Mac mini. Sem treino, sem pipeline.
- **Fase B (adapter):** se existir, carrega o LoRA `gemma-twin` mais recente sobre o modelo base.

### 3.3 Detecção de capacidade

No bootstrap do daemon: testa disponibilidade do FoundationModels (`#available` + probe). Disponível → `FoundationModelsProvider`. Indisponível → `GemmaProvider`.

## 4. Fase B — destilação passiva (`AegisTwinTrainer`)

Processo passivo de background no **Mac mini**, via `launchd`. Não bloqueia nada; melhora o twin ao longo do tempo, em paralelo ao uso normal da Apple Intelligence, sem interferir.

**Gate de ativação** (as 3 condições simultâneas): (a) Mac mini na Tailscale · (b) plugado na energia · (c) idle.

**Ciclo:**
1. **Captura.** O `AegisTwinTrainer` intercepta as chamadas reais ao FoundationModels feitas durante o dia e grava os pares `{tarefa, input, saída-FM}` num buffer JSONL.
2. **Treino incremental.** A cada **5.000 pares OU 7 dias** (o que vier primeiro), roda um mini-LoRA incremental — *warm-start* sobre o adapter vigente, não do zero — via MLX, em janela ociosa.
3. **Eval automatizado.** O novo adapter só é **promovido** se bater os thresholds **sem regressão** vs. o adapter vigente.
4. **Distribuição.** O adapter promovido vira uma nova **tag ODR** (`gemma-twin-v1.1`, `v1.2`…); o iOS baixa sozinho na próxima abertura do app.

## 5. Fluxos

- **iOS — qualquer tarefa:** plugin → `ZeusHttpClient` → `AegisDaemon` → `GemmaProvider` → MLX (Gemma + few-shot + adapter, se houver) → resposta.
- **Mac — qualquer tarefa:** plugin → `zeusdaemon-mac` → `FoundationModelsProvider` → resposta **+** o `AegisTwinTrainer` intercepta e grava o par no buffer.
- **Treino:** gate (Tailscale + plugado + idle) satisfeito + (5k pares ou 7 dias) → mini-LoRA → eval → (se passa) promove → tag ODR.

## 6. Erros e degradação

- Gemma ainda carregando no iOS → daemon responde estado "modelo carregando"; a busca usa o fallback substring atual.
- Run de treino que não passa no eval → descartado; adapter atual mantido.
- Fase A (few-shot) funciona desde o dia 1, sem nenhum adapter.
- Linha JSONL inválida no buffer → pulada e logada; o ciclo segue.

## 7. Testes

- `GenerativeProvider`: testes de contrato com um `MockProvider`.
- `GemmaProvider`: teste por tarefa — saída bem-formada e parseável.
- Fase B: o **eval FM-vs-Gemma é o teste** — mede a proximidade e é o gate de promoção.
- Cross-device: iOS usa `GemmaProvider`, Macs usam `FoundationModelsProvider`, mesmo contrato.

## 8. Faseamento

- **Fase A — v1.0.0 (agora, valor imediato, zero pipeline).** `GenerativeProvider` + refatorar o FM atrás dele + `GemmaProvider` com Gemma 4 stock + `AppleTwinSystemPrompt.swift` + 3-5 pares curados por tarefa + detecção de capacidade + deploy iOS. Sem captura longa, sem espera de LoRA. Bump direto a **v1.0.0**.
- **Fase B — destilação passiva (background, melhoria medida).** `AegisTwinTrainer` (launchd) + middleware de captura + treino incremental + eval + distribuição via tags ODR `gemma-twin-v1.1+`.

## 9. Riscos e restrições

- O `AegisDaemon` (Swift) ganha complexidade real (MLX + 7 tarefas). O target iOS depende de deploy via Xcode workspace — o build SPM por CLI do target `AegisDaemon` falha (símbolo `CapivaraDeviceProfile.current`, conhecido do CHANGELOG v1.3.4).
- **ODR:** On-Demand Resources é hospedado pela App Store. Se o app iOS não é App-Store-distribuído (sideload / deploy via Xcode), o ODR padrão não se aplica — confirmar o mecanismo de download do adapter (pode exigir esquema self-hosted via Tailscale/iCloud).
- "100% de identidade" com a Apple Intelligence não é atingível — modelos diferentes. Meta: **paridade funcional alta**; o eval (§4.3) quantifica a proximidade.
- Esforço de várias semanas, atravessando Swift, MLX e um mini-pipeline de MLOps.

## 10. Decisões diferidas para a implementação

Resolvidas na reformulação Fase A/B: variante (E2B iPhone / E4B iPad — D1) e distribuição (tags ODR — §4.4).

Em aberto, a fixar na implementação:
- Métrica e thresholds exatos do eval — embedding-similarity vs. LLM-as-judge vs. combinação.
- Mecanismo de distribuição do adapter caso o app iOS não seja App-Store-distribuído (ver §9, ODR).
