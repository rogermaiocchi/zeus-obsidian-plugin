# Design — Token-auth adaptativo do daemon Zeus

- **Data:** 2026-05-16
- **Status:** design aprovado — a dobrar no task que reestrutura o daemon (camada Gemma).
- **Origem:** retomada do item de segurança pausado no brainstorm de 2026-05-16. Companheiro de `2026-05-16-camada-gemma4-design.md` — ambos mexem no daemon Swift.

## 1. Contexto e objetivo

O daemon `zeusdaemon-mac` escuta em `0.0.0.0:2223` e expõe ~25 endpoints POST **sem autenticação** — acessíveis por qualquer host na LAN doméstica e em toda a tailnet. O estudo do plugin Zeus (2026-05-16) apontou isso como o risco mais grave.

**Objetivo:** exigir autenticação nas requests **sem quebrar o acesso cross-device** (iPhone/iPad/MacBook lendo o daemon do Mac mini via Tailscale — arquitetura deliberada do Zeus).

**Não-objetivos:** trancar o daemon em `127.0.0.1` (quebraria o cross-device); TLS de transporte (a tailnet já é cifrada — o escopo aqui é só autenticação).

## 2. Decisão

Autenticação por **token**, com política **adaptativa por origem da request** — o mesmo binário se ajusta ao ambiente onde roda, sem flag ou config por aparelho.

## 3. Design

### 3.1 Política por origem da request

| Origem | Regra |
|---|---|
| Loopback (`127.0.0.1`, `::1`) | Liberada, sem token — o plugin chamando o daemon do próprio aparelho é confiável. |
| Não-loopback (LAN / tailnet) | Exige header `X-Zeus-Token` válido; senão `401`. |
| `GET /v1/health` | Sempre liberado — diagnóstico. |

Efeito adaptativo: num aparelho acessado só por loopback, o token nunca pesa; no Mac mini (exposto, chamado pelos outros via tailnet), o token é exigido desses callers. O daemon decide por request — nenhuma configuração de ambiente.

### 3.2 Token

- O daemon mantém um **conjunto** de tokens aceitos (não um hardcoded), lido de `~/.config/zeus/tokens` (`chmod 600`). Permite rotação e revogação de um aparelho sem afetar os outros.
- O `ZeusHttpClient` (plugin) anexa `X-Zeus-Token` nas requests não-loopback. Como loopback é isento, só callers cross-device carregam token.
- **Distribuição:** token gerado uma vez e distribuído aos aparelhos via Tailscale (mesmo canal do adapter Gemma). Evitar segredo em arquivo sincronizado por iCloud.

### 3.3 Mudanças no daemon Swift

Entram junto da reestruturação do `GenerativeProvider` que o task já faz:

1. **Middleware de auth** no handler HTTP (`ZeusMacHTTPHandler.swift`, `AegisHTTPHandlers.swift`), **antes** do roteamento por endpoint: detecta loopback → se não, valida `X-Zeus-Token` contra o conjunto.
2. **Carga do conjunto de tokens** no bootstrap (`main.swift`); se o arquivo não existir, gera um token inicial e o cria.
3. **`ZeusHttpClient`** (`lib/zeus-http-client.js`): anexa o header nas requests não-loopback.

## 4. Erros e degradação

- Token ausente/inválido em request não-loopback → `401`, sem vazar detalhe.
- Arquivo de tokens ausente no bootstrap → daemon gera um e cria o arquivo; não falha.
- Loopback nunca quebra — o caminho local funciona mesmo sem token configurado.

## 5. Testes

- Loopback sem token → `200`.
- Não-loopback: sem token → `401`; token válido → `200`; token inválido → `401`.
- `GET /v1/health` de qualquer origem, sem token → `200`.
- Cross-device real: iPhone/iPad/MacBook → daemon do Mac mini com token → `200`.

## 6. Coordenação

Esta peça modifica os **mesmos arquivos** do daemon (`ZeusMacHTTPHandler.swift`, `AegisHTTPHandlers.swift`, `main.swift`) que o task está reestruturando para a camada Gemma. Por isso é **dobrada no mesmo task** — entra como parte da reestruturação, sem edição concorrente nem conflito de merge. Não executar em esforço separado e paralelo.

## 7. Decisões diferidas

- Canal concreto de distribuição/rotação do token via Tailscale.
- Se a política deve distinguir tailnet de LAN-não-tailnet (hoje ambas contam como "não-loopback").
