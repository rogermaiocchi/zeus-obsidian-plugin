---
tipo: adr
criado: 2026-05-20
atualizado: 2026-05-20
status: ativo
adr_number: 010
adr_title: MobileCLIP opt-in stub — endpoints v1.9 sem bundle do modelo (+250MB)
---

# ADR-010 — MobileCLIP Opt-In Stub (endpoints v1.9 sem bundle de modelo)

## Contexto

A funcionalidade alvo é busca text→image zero-shot dentro do vault: o usuário digita "diagrama de fluxo de processo" e o plugin acha imagens que casam pelo embedding visual, mesmo que a imagem não tenha OCR, nome descritivo ou tags. A primitiva certa para isso é um modelo CLIP/MobileCLIP rodando on-device, com encoders separados para imagem e texto, projetando ambos no mesmo espaço vetorial 512-dim.

Apple liberou MobileCLIP em variantes S0 (~85MB), S1 (~130MB), S2 (~190MB) e B (~370MB) — todos em `.mlpackage` (CoreML). O encoder visual e o encoder de texto vão em arquivos separados.

### Sinais e fatos

1. **Bundle do modelo dentro do plugin Obsidian é tóxico.** Variantes pequenas (S0) já passam de 85MB, e a S2 está em 190MB. Plugins Obsidian carregam tudo em memória do Electron e propagam via Obsidian Sync — distribuir +250MB de pesos congelados em cada release piora cold-start, infla `community-plugins.json`, e gasta banda do usuário (incluindo iCloud sync, mesmo em devices que não têm CoreML).
2. **Codex brainstorm v1.8 (parecer final):** "MobileCLIP entra como opt-in: `~/Library/Application Support/Zeus/mobileclip-model/`, comando 'instalar modelo', endpoint stub retornando erro acionável até modelo existir. Nada de bundle +250MB. Também vale mirar MobileCLIP-S0/S2 antes de variantes maiores."
3. **CoreML runtime já está disponível** em `canImport(CoreML)` no daemon Mac — não precisamos linkar dependência nova. O custo é só carregar o `.mlpackage` na primeira chamada e cachear o `MLModel`.
4. **Frontend (lib/zeus-http-client.js) deve estar pronto antes do backend ficar pronto** — assim, quando v2.0 entregar o runtime CoreML, os call sites no plugin (`smart-connections`, `hybrid-search`) não precisam mudar. Só o handler Swift muda do stub para a inferência real.
5. **501 com `hint` acionável > 404 silencioso.** Se o endpoint não existe (404), o plugin acha que está falando com daemon velho. Se retornar 501 com `hint: "Rode 'Zeus: instalar modelo MobileCLIP'"`, o usuário tem o caminho claro para destravar.

## Decisão

**Adicionar 3 endpoints MobileCLIP STUB em v1.9, com runtime CoreML real adiado para v2.0:**

### Endpoints (daemon Swift)

| Método | Path | Comportamento v1.9 | v2.0 alvo |
|---|---|---|---|
| `GET`  | `/v1/mobileclip/status` | `200 OK` reportando `installed`, `model_dir`, `expected_files`, `variant_default: "S0"`. | Sem mudança — schema estável. |
| `POST` | `/v1/mobileclip/embed-image` | `501 Not Implemented` com `hint` acionável (modelo ausente) OU `501 stub v1.9` (modelo presente mas runtime pendente). | Carregar MLPackage, processar imagem via `VNImageRequestHandler`/`MLFeatureProvider`, retornar embedding 512-dim. |
| `POST` | `/v1/mobileclip/embed-text` | Mesma estrutura 501 do embed-image. | Tokenizar texto (BPE) → text encoder MLPackage → embedding 512-dim. |

### Caminho de instalação do modelo

```
~/Library/Application Support/Zeus/mobileclip-model/
├── model-manifest.json                  # { "version": "1.0", "variant": "S0" }
├── MobileCLIP-S0-vision.mlpackage/
└── MobileCLIP-S0-text.mlpackage/
```

Detecção: `FileManager.default.fileExists(atPath: <dir>/model-manifest.json)`. Sem manifesto → considera-se não instalado.

### UX do plugin (main.source.js)

Dois comandos novos:

- `zeus-mobileclip-status` — chama `GET /v1/mobileclip/status` e mostra Notice ("INSTALADO em ..." vs. "NÃO instalado · use comando 'instalar modelo'").
- `zeus-mobileclip-install` — em v1.9, **não baixa** o modelo. Apenas escreve no clipboard o passo-a-passo manual (mkdir, curl/download, cp, criar `model-manifest.json`). Em v2.0, este mesmo comando virará o download automatizado.

### Variant default: S0

S0 é o ponto de equilíbrio: 85MB, 81 IN1k accuracy, latência ~3ms M2 Pro. S2 fica disponível para quem quiser trocar manualmente editando `model-manifest.json` — sem mudança de código.

## Tradeoffs

| Dimensão | v1.9 stub | Bundle do modelo no plugin | Download automatizado em v1.9 |
|---|---|---|---|
| Install UX | release plugin <2MB, igual hoje | release +85-250MB | release leve, mas onload trava em N segundos no primeiro uso |
| Latência primeiro uso | n/a (501 + hint) | Imediato | Download síncrono — UX ruim sem progress bar |
| Frontend ready | Sim (schema fechado) | Sim | Sim, mas com complexidade de retry/checksum/cancel |
| Esforço v1.9 | ~1h (3 handlers stub + 2 commands + lib) | +1 dia (bundling, CDN, hashes) | +2 dias (download manager + UX + integridade) |
| Esforço v2.0 | Trocar 3 handlers stub por inferência CoreML | Trocar 3 handlers stub por inferência CoreML | Trocar 3 handlers stub por inferência CoreML |

**Custo do stub:** text→image zero-shot continua indisponível até v2.0. Mas: (a) hoje não existe nem o esqueleto; (b) o usuário tem como destravar manualmente sem esperar v2.0 — basta seguir as instruções do comando install; (c) quando v2.0 chegar, **o frontend não muda** — só preenchemos os 3 handlers Swift com a inferência real.

## Implementação v1.9

### daemon Swift (`daemon/Sources/ZeusDaemonMac/ZeusMacHTTPHandler.swift`)

```swift
#if canImport(CoreML)
import CoreML
#endif

// route handler:
case (.POST, "/v1/mobileclip/embed-image"):
    return self.handleMobileCLIPEmbedImage(bodyJSON: body)
case (.POST, "/v1/mobileclip/embed-text"):
    return self.handleMobileCLIPEmbedText(bodyJSON: body)
case (.GET, "/v1/mobileclip/status"):
    return self.handleMobileCLIPStatus()
```

Os 3 handlers + helpers (`mobileCLIPModelPath`, `mobileCLIPModelInstalled`) ficam no fim da classe `ZeusMacHTTPHandler`.

### lib/zeus-http-client.js

```js
async mobileclipStatus() { ... GET /v1/mobileclip/status ... }
async mobileclipEmbedImage(imagePath) { ... POST /v1/mobileclip/embed-image ... }
async mobileclipEmbedText(text) { ... POST /v1/mobileclip/embed-text ... }
```

### main.source.js

Dois comandos novos (`zeus-mobileclip-status`, `zeus-mobileclip-install`), ambos gated por `isMac()`.

## Plano v2.0 (out of scope desta ADR)

1. Implementar carregamento `MLPackage` em `handleMobileCLIPEmbedImage`/`handleMobileCLIPEmbedText`, cacheado em property estática.
2. Implementar pipeline `image_path` → `CGImage` → `MLFeatureProvider` → `MLModel.prediction` → `[Float]` 512-dim.
3. Implementar tokenizador BPE em Swift para o text encoder (alternativa: Python sidecar — descartado).
4. Substituir o `clipboard.writeText` do comando install pelo download `fetch` HTTPS + verificação de checksum (SHA-256 publicado no `model-manifest.json` de referência).
5. Atualizar `image-similarity.js` (lib/) para consumir os endpoints e ranquear via cosine.

## Cross-referência

- `daemon/Sources/ZeusDaemonMac/ZeusMacHTTPHandler.swift` — handlers stub + imports.
- `lib/zeus-http-client.js` — métodos client `mobileclipStatus`, `mobileclipEmbedImage`, `mobileclipEmbedText`.
- `main.source.js` — comandos `zeus-mobileclip-status`, `zeus-mobileclip-install`.
- `lib/image-similarity.js` — consumer alvo em v2.0.
- ADR-006, ADR-007, ADR-008, ADR-009 — séries de feature ADRs v1.8/v1.9.
