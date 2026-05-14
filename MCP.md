# Zeus MCP Tool Surface

Zeus daemon (HTTP `http://127.0.0.1:2223`) expõe ferramentas que agents Claude / `afm` / qualquer cliente MCP consomem em padrão **progressive disclosure**: começa com passports (concepts + summary + domain + difficulty) e só desce ao conteúdo bruto quando o LLM decidir que precisa.

Versão: **v0.9.0** (Passport Index Architecture / PIA — ADR-018).

## Princípio: progressive disclosure

Em vez de jogar 5 notas completas (~25 KB) no contexto do LLM logo na primeira query, oferecemos camadas:

1. **Passport** (~200-500 B por nota) — quem é, do que fala, em que domínio, com que dificuldade.
2. **Conteúdo bruto** (1-50 KB por nota) — só quando o agente determina que precisa ler.

O agente decide quando fazer drill-down. O daemon nunca empurra conteúdo bruto sem pedido explícito.

## Tools (in order of typical usage)

### 1. `find_relevant_notes(query, [concept_filter], [top_n], [min_score])`

- **Endpoint**: `POST /v1/passport/find`
- **Body**:
  ```json
  {
    "query": "arquitetura Aegis com Tailscale",
    "embeddings_jsonl_path": ".../data/embeddings.jsonl",
    "passports_jsonl_path": ".../data/passports.jsonl",
    "top_n": 10,
    "min_score": 0.3,
    "concept_filter": null
  }
  ```
- **Returns**: array of passports (path + concepts + one_line_summary + domain + difficulty + score)
- **WITHOUT raw content** — token-efficient first probe
- **Typical payload**: 1-2 KB
- **Use when**: agent recebe pergunta nova e precisa ranquear notas candidatas.

```json
{
  "results": [
    {
      "path": "20_Arquitetura/Aegis.md",
      "concepts": ["Tailscale", "SwiftNIO", "Aegis daemon"],
      "one_line_summary": "Padrão Aegis: daemon Swift local servindo HTTP local + Tailscale cross-device.",
      "domain": ["Tech"],
      "difficulty": 3,
      "score": 0.87
    }
  ]
}
```

### 2. `get_passport(path)`

- **Endpoint**: included in `/v1/passport/find` response, or extract a single via `POST /v1/passport/extract`
- **Body** (`/v1/passport/extract`):
  ```json
  { "path": "20_Arquitetura/Aegis.md", "domain_options": [] }
  ```
- **Returns**: full passport for specific note (re-extracts if needed)
- **Typical payload**: 200-500 bytes
- **Use when**: agent precisa do passport de UMA nota específica (sem busca).

### 3. `get_content(path, [max_chars])`

- **Endpoint**: `POST /v1/content/get`
- **Body**:
  ```json
  { "path": "20_Arquitetura/Aegis.md", "vault_root": "/Users/.../Metassistema", "max_chars": 50000 }
  ```
- **Returns**: raw markdown content
- **ONLY call after** passport indicates this note is needed
- **Typical payload**: 1-50 KB (capped by `max_chars`)
- **Use when**: o agente já decidiu, com base no passport, que precisa ler a nota inteira.

## Token economics

| Cenário | Estratégia | Bytes ao LLM |
|---|---|---|
| **Naive RAG** | query → cosine top-5 com conteúdo completo | ~5 KB × 5 = **25 KB** |
| **PIA / Zeus v0.9** | `find_relevant_notes` (top-10 passports) → LLM decide 1-2 deep-dive → `get_content` | **~3 KB + 5-15 KB = 8-18 KB** |

**Savings estimado: 60-80% em tokens** para queries típicas.

A heurística "1 token ≈ 4 bytes" (PT/EN texto) traduz isso em:
- Naive: ~6.250 tokens consumidos só em contexto.
- PIA: ~2.000-4.500 tokens consumidos.

Métricas reais vêm de `ZeusHttpClient.getMetrics()` (bytes in/out por endpoint, contadores acumulados desde load).

## Persistência canônica vs derivativa

| Artefato | Papel | Quem grava | Quem lê |
|---|---|---|---|
| `data/passports.jsonl` | **CANÔNICO** | Daemon batch-extract | MCP tools, plugin |
| `data/zeus-cards.base` | **UI derivative** | Plugin `bases-generator` | Obsidian Bases plugin |
| Frontmatter `zeus_related` | Graph nativo | Plugin v0.8 native-graph | Obsidian Graph view |

Bases NUNCA é consumido por MCP. Bases é apenas a vista tabular humana das mesmas passports.

## Integration with `afm serve`

`afm serve` (Apple Foundation Models CLI em daemon mode) já expõe MCP JSON-RPC. Para wrappar as 3 ferramentas Zeus dentro de `afm`:

```jsonc
// ~/.afm/mcp-tools.json
{
  "tools": [
    {
      "name": "find_relevant_notes",
      "description": "Find Obsidian notes relevant to a query. Returns passports (concepts + summary + domain), NOT raw content. Use as first probe before get_content.",
      "transport": "http",
      "endpoint": "http://127.0.0.1:2223/v1/passport/find",
      "schema": {
        "type": "object",
        "properties": {
          "query": { "type": "string" },
          "top_n": { "type": "integer", "default": 10 },
          "concept_filter": { "type": "array", "items": { "type": "string" } }
        },
        "required": ["query"]
      }
    },
    {
      "name": "get_passport",
      "description": "Extract or fetch the passport (concepts + summary + domain + difficulty) for a specific note path.",
      "transport": "http",
      "endpoint": "http://127.0.0.1:2223/v1/passport/extract"
    },
    {
      "name": "get_content",
      "description": "Fetch raw markdown content for a specific note. Call ONLY after passport indicates this note is needed.",
      "transport": "http",
      "endpoint": "http://127.0.0.1:2223/v1/content/get"
    }
  ]
}
```

A camada Claude Code / `afm` enxerga as 3 tools como JSON-RPC; nada muda do lado do agente. O daemon Zeus age como single point of authority sobre o vault.

## Plugin-side commands (Obsidian palette)

| Comando | Endpoint | Função |
|---|---|---|
| `zeus-passport-build-all` | `/v1/passport/batch-extract` | Extrai passports de todo o vault, persiste JSONL, regenera `.base` |
| `zeus-passport-build-current` | `/v1/passport/extract` | Extrai passport da nota ativa |
| `zeus-passport-find` | `/v1/passport/find` | Modal de busca por query, exibe cards |
| `zeus-bases-regenerate` | (local) | Regenera `zeus-cards.base` do `passports.jsonl` |

## Telemetria (métricas de token saved)

```js
const m = this.app.plugins.plugins['zeus'].httpClient.getMetrics();
// {
//   requests: 47,
//   bytesIn: 124000,        // total bytes recebidos
//   bytesOut: 8400,         // total bytes enviados
//   estimatedTokens: 33100, // (bytesIn + bytesOut) / 4
//   byEndpoint: {
//     "/v1/passport/find":    { count: 12, bytesIn: 15000, bytesOut: 1200 },
//     "/v1/content/get":      { count:  3, bytesIn: 42000, bytesOut:  400 },
//     ...
//   },
//   sinceMs: 7200000
// }
```

Use isso para validar empiricamente os 60-80% de savings em sessões reais.

## Referências

- `lib/passport-index.js` — implementação da Camada 2 client-side
- `lib/bases-generator.js` — gerador de Obsidian Bases YAML
- `lib/zeus-http-client.js` — transport HTTP + métricas
- `20_Arquitetura/ADR/ADR-018-Zeus-Architecture-Aegis-Pattern.md` — daemon doctrine
- Brainstorm session 2026-05-14 — fundamentação PIA
