/*
 * ZeusHttpClient — daemon HTTP transport (v0.9 padrão Aegis — full Apple ecosystem + PIA)
 *
 * Cliente HTTP que fala com daemon Swift nativo rodando em 127.0.0.1:2223
 * (ou Tailscale cross-device). Substitui o child_process.spawn no hot path
 * quando o daemon está disponível; faz fallback gracioso para spawn caso contrário.
 *
 * Mesmo código funciona em Mac, iPhone, iPad — porque usa Obsidian's
 * requestUrl API (bypass CORS oficial em mobile + Electron).
 *
 * v0.9 — Passport Index Architecture (PIA) endpoints:
 *   POST /v1/passport/extract        body: {path, domain_options}
 *   POST /v1/passport/batch-extract  body: {paths, domain_options}
 *   POST /v1/passport/find           body: {query, embeddings_jsonl_path, passports_jsonl_path,
 *                                            top_n, min_score, concept_filter}
 *   POST /v1/content/get             body: {path, vault_root, max_chars}
 *
 * v0.9 — Token metrics: this.metrics tracks bytes in/out per endpoint.
 *
 * Endpoints canônicos (per ADR-018) — v0.7 cobertura completa Apple frameworks:
 *   POST /v1/embed                  body: {text}                  → {vectors, dim, model, count}
 *   POST /v1/enrich                 body: {note_content, note_path, vault_summary}
 *   POST /v1/agent                  body: {question, pattern}
 *   POST /v1/ocr                    body: {path, output_format, language}
 *   POST /v1/summarize              body: {text}
 *   POST /v1/graph/extract          body: {text, max_nodes, max_edges}
 *   POST /v1/classify               body: {text, options}
 *   POST /v1/prompt                 body: {instruction, max_tokens, deterministic}
 *   POST /v1/vision/classify        body: {path, top_n}
 *   POST /v1/vision/landmarks       body: {path}
 *   POST /v1/vision/saliency        body: {path, mode}             (NEW v0.7 — VNGenerateAttentionBasedSaliencyImageRequest)
 *   POST /v1/vision/feature-print   body: {path}                   (NEW v0.7 — VNGenerateImageFeaturePrintRequest 768-dim)
 *   POST /v1/vision/aesthetics      body: {path}                   (NEW v0.7 — VNCalculateImageAestheticsScoresRequest)
 *   POST /v1/vision/barcode         body: {path}                   (NEW v0.7 — VNDetectBarcodesRequest)
 *   POST /v1/vision/document        body: {path}                   (NEW v0.7 — VNRecognizeDocumentsRequest layout-aware)
 *   POST /v1/translate              body: {text, source_lang, target_lang} (NEW v0.7 — Apple Translation framework)
 *   POST /v1/nl/tag                 body: {text, scheme}           (NEW v0.7 — NLTagger lemma/nameType)
 *   POST /v1/nl/sentiment           body: {text}                   (NEW v0.7 — NLTagger sentimentScore)
 *   POST /v1/nl/language-detect     body: {text, top_n}            (NEW v0.7 — NLLanguageRecognizer)
 *   POST /v1/data-detect            body: {text}                   (NEW v0.7 — NSDataDetector URLs/phones/dates)
 *   POST /v1/spotlight/search       body: {query, scope, limit}    (NEW v0.7 — CSSearchQuery bridge)
 *   GET  /v1/health
 *   GET  /v1/tools
 *
 * Referência: 20_Arquitetura/ADR/ADR-018-Zeus-Architecture-Aegis-Pattern.md
 */

'use strict';

const universal = require('./universal-fs');

class ZeusHttpClient {
  constructor(baseUrl) {
    this.baseUrl = (baseUrl || 'http://127.0.0.1:2223').replace(/\/$/, '');
    this.healthCache = null;
    this.healthCheckedAt = 0;
    this.HEALTH_TTL_MS = 30000;   // re-probe daemon health every 30s

    // v0.9 — Token economics instrumentation
    this.metrics = {
      requests: 0,
      bytesIn: 0,        // bytes received from daemon (response payload)
      bytesOut: 0,       // bytes sent to daemon (request payload)
      byEndpoint: new Map(),   // endpoint → { count, bytesIn, bytesOut }
      startedAt: Date.now(),
    };

    // v2.0 — Apple Cloud Private (PCC) routing. v1.15: o routing real é decidido
    // pela Apple (sem API pública de controle/inspeção). Estes modos só controlam
    // a PERMISSÃO enviada no header; o daemon sinaliza POSSIBILIDADE de cloud.
    // pccMode: 'off' | 'opt-in' | 'auto'
    //   'off'    → no PCC permission header sent; on-device only
    //   'opt-in' → header X-Zeus-Allow-Pcc:1; Apple decides per request
    //   'auto'   → header X-Zeus-Allow-Pcc:auto; daemon flags possibility when load exceeds on-device
    // v1.15 — codex #5: "used" virou "possible". O daemon NÃO consegue medir uso
    // real de PCC (Apple não expõe API de inspeção); só estima possibilidade. Os
    // campos refletem honestamente "cloud era possível", não "cloud foi usado".
    this.pccMode = 'off';
    this.lastPccPossible = false;      // updated from response header X-Zeus-Pcc-Possible
    this.pccPossibleCount = 0;         // total requests onde cloud era possível (heurística)
  }

  setPccMode(mode) {
    const valid = ['off', 'opt-in', 'auto'];
    this.pccMode = valid.includes(mode) ? mode : 'off';
  }

  getPccStatus() {
    return {
      mode: this.pccMode,
      lastPossible: this.lastPccPossible,
      possibleCount: this.pccPossibleCount,
    };
  }

  /**
   * Snapshot of current metrics + estimated token cost.
   * Heuristic: 1 token ~= 4 bytes for English/Portuguese text (very rough).
   */
  getMetrics() {
    const byEndpoint = {};
    for (const [k, v] of this.metrics.byEndpoint) {
      byEndpoint[k] = {
        count: v.count,
        bytesIn: v.bytesIn,
        bytesOut: v.bytesOut,
        estimatedTokens: Math.round((v.bytesIn + v.bytesOut) / 4),
      };
    }
    return {
      requests: this.metrics.requests,
      bytesIn: this.metrics.bytesIn,
      bytesOut: this.metrics.bytesOut,
      estimatedTokens: Math.round((this.metrics.bytesIn + this.metrics.bytesOut) / 4),
      byEndpoint,
      sinceMs: Date.now() - this.metrics.startedAt,
    };
  }

  resetMetrics() {
    this.metrics = {
      requests: 0,
      bytesIn: 0,
      bytesOut: 0,
      byEndpoint: new Map(),
      startedAt: Date.now(),
    };
  }

  _recordMetric(endpoint, bytesOut, bytesIn) {
    this.metrics.requests++;
    this.metrics.bytesOut += bytesOut;
    this.metrics.bytesIn += bytesIn;
    let row = this.metrics.byEndpoint.get(endpoint);
    if (!row) { row = { count: 0, bytesIn: 0, bytesOut: 0 }; this.metrics.byEndpoint.set(endpoint, row); }
    row.count++;
    row.bytesIn += bytesIn;
    row.bytesOut += bytesOut;
  }

  setBaseUrl(url) {
    this.baseUrl = (url || 'http://127.0.0.1:2223').replace(/\/$/, '');
    this.healthCache = null;
  }

  _isLoopbackBaseUrl() {
    return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(this.baseUrl || '');
  }

  _isPrivatePath(path, payload = {}) {
    if (typeof path === 'string' && path) {
      // vault-relative (Clientes/...) OU absoluto/aninhado (/Users/.../Clientes/...)
      if (/^Clientes\//i.test(path.replace(/^\/+/, ''))) return true;
      if (/(^|\/)Clientes\//i.test(path)) return true;
    }
    if (payload && payload.privacy && /sigiloso/i.test(String(payload.privacy))) return true;
    return false;
  }

  _assertRawContentAllowed(endpoint, options = {}) {
    const privacyPath = options._privacyPath || options.privacyPath || options.path || null;
    if (!this._isLoopbackBaseUrl() && this._isPrivatePath(privacyPath, options)) {
      throw new Error(
        `privacy-gate: ${endpoint} recusou enviar conteúdo sigiloso para daemon remoto (${this.baseUrl})`,
      );
    }
  }

  // Lazy health check — cached for HEALTH_TTL_MS
  // v1.4.1 — timeoutMs (default 1500ms): probes precisam falhar rápido em URLs mortas
  // para que discovery cross-device funcione sem travar Obsidian no startup.
  async isAvailable(timeoutMs = 1500) {
    const now = Date.now();
    if (this.healthCache !== null && (now - this.healthCheckedAt) < this.HEALTH_TTL_MS) {
      return this.healthCache;
    }
    try {
      // Race a probe HTTP contra um timer — Obsidian's requestUrl não respeita AbortController,
      // então usamos Promise.race como timeout externo.
      const probe = this._requestUrl({
        url: `${this.baseUrl}/v1/health`,
        method: 'GET',
        throw: false,
      });
      const timeout = new Promise(resolve =>
        setTimeout(() => resolve({ status: 0, _timedOut: true }), timeoutMs)
      );
      const resp = await Promise.race([probe, timeout]);
      const ok = resp && resp.status >= 200 && resp.status < 300;
      this.healthCache = ok;
    } catch {
      this.healthCache = false;
    }
    this.healthCheckedAt = Date.now();
    return this.healthCache;
  }

  // v2.0 — Inject PCC routing header into outgoing request headers.
  _pccHeaders() {
    if (this.pccMode === 'off') return {};
    if (this.pccMode === 'auto') return { 'X-Zeus-Allow-Pcc': 'auto' };
    return { 'X-Zeus-Allow-Pcc': '1' };  // opt-in
  }

  // v2.0 — Read PCC-routing signal from response headers.
  // v1.15 — codex #5: o daemon sinaliza `X-Zeus-Pcc-Possible: 1` quando cloud era
  // POSSÍVEL (heurística), não quando foi comprovadamente usado — Apple não expõe
  // API de inspeção de routing.
  _readPccPossible(headers) {
    if (!headers) return false;
    // Obsidian requestUrl returns headers as plain object; fetch returns Headers instance
    const val = typeof headers.get === 'function'
      ? headers.get('x-zeus-pcc-possible') || headers.get('X-Zeus-Pcc-Possible')
      : (headers['x-zeus-pcc-possible'] || headers['X-Zeus-Pcc-Possible']);
    const possible = val === '1' || val === 'true';
    if (possible) this.pccPossibleCount++;
    this.lastPccPossible = possible;
    return possible;
  }

  // Try to load Obsidian's requestUrl from the obsidian module; fallback to fetch on Node
  async _requestUrl({ url, method = 'GET', body, contentType = 'application/json', throw: throwOnError = true, signal = null }) {
    let obsidian;
    try { obsidian = require('obsidian'); } catch { obsidian = null; }

    const pccHeaders = this._pccHeaders();

    if (obsidian && obsidian.requestUrl) {
      // Obsidian environment — preferred
      const resp = await obsidian.requestUrl({
        url, method, contentType,
        headers: { 'Content-Type': contentType, ...pccHeaders },
        body: typeof body === 'string' ? body : (body ? JSON.stringify(body) : undefined),
        throw: throwOnError,
      });
      this._readPccPossible(resp.headers);
      return resp;
    }

    // Node fallback (testing, scripts)
    if (typeof fetch === 'function') {
      const resp = await fetch(url, {
        method,
        headers: { 'Content-Type': contentType, ...pccHeaders },
        body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
        signal,
      });
      this._readPccPossible(resp.headers);
      const text = await resp.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: resp.status, text, json, headers: resp.headers };
    }

    throw new Error('Nenhum transporte HTTP disponível (sem obsidian.requestUrl, sem fetch)');
  }

  async _post(endpoint, body, timeoutMs = 60000, privacyCtx = null) {
    // v1.14 — privacy gate CENTRALIZADO (codex HIGH #4). Cobre TODOS os endpoints,
    // não só /v1/embed. Deriva o path sensível do body (path/note_path/image_path)
    // ou de privacyCtx explícito (caso /v1/embed, cujo body é texto já extraído).
    const privacyPath = (privacyCtx && (privacyCtx._privacyPath || privacyCtx.privacyPath))
      || (body && typeof body === 'object'
        ? (body.path || body.note_path || body.notePath || body.image_path || null)
        : null);
    const privacyTag = (privacyCtx && privacyCtx.privacy)
      || (body && typeof body === 'object' ? body.privacy : null);
    this._assertRawContentAllowed(endpoint, { _privacyPath: privacyPath, privacy: privacyTag });

    const ctrl = new (typeof AbortController !== 'undefined' ? AbortController : class { constructor(){this.signal=null;} abort(){} })();
    let timer = null;
    // v0.9 — instrument bytes-out (request payload)
    const bodyStr = typeof body === 'string' ? body : (body ? JSON.stringify(body) : '');
    const bytesOut = bodyStr ? universal.byteLength(bodyStr) : 0;
    try {
      const request = this._requestUrl({
        url: `${this.baseUrl}${endpoint}`,
        method: 'POST',
        body: bodyStr,
        signal: ctrl.signal,
      });
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          try { if (ctrl.abort) ctrl.abort(); } catch {}
          reject(new Error(`Daemon ${endpoint}: timeout após ${timeoutMs}ms`));
        }, timeoutMs);
      });
      const resp = await Promise.race([request, timeout]);
      // v0.9 — instrument bytes-in (response payload)
      const respText = resp.text || (resp.json ? JSON.stringify(resp.json) : '');
      const bytesIn = respText ? universal.byteLength(respText) : 0;
      this._recordMetric(endpoint, bytesOut, bytesIn);

      if (resp.status >= 400) {
        const err = (resp.json && resp.json.error) || resp.text || `HTTP ${resp.status}`;
        throw new Error(`Daemon ${endpoint}: ${err}`);
      }
      return resp.json || JSON.parse(resp.text);
    } finally {
      clearTimeout(timer);
    }
  }

  // High-level API mirroring afm CLI subcommands
  async embed(text, options = {}) {
    const { _privacyPath, privacyPath, privacy, ...wireOptions } = options || {};
    // privacy gate aplicado centralmente em _post via privacyCtx (body é texto, sem path)
    // Returns { vectors: [[...]], dim, model, count }
    return await this._post('/v1/embed', { text, ...wireOptions }, 60000,
      { _privacyPath: _privacyPath || privacyPath, privacy });
  }

  // v1.3.0 — afm refine (Writing Tools nativo)
  // mode: "proofread|rewrite|simplify"; tone para rewrite: "academic|professional|casual"
  // v1.15 — codex round 5: aceita _privacyPath/privacy no options para o gate ver a
  // proveniência do `text` (conteúdo já extraído, sem path no body).
  async refine(text, mode = 'proofread', options = {}) {
    const { _privacyPath, privacyPath, privacy, ...wireOptions } = options || {};
    return await this._post('/v1/afm/refine', { text, mode, ...wireOptions }, 90000,
      { _privacyPath: _privacyPath || privacyPath, privacy });
  }

  // v1.3.0 — asp transcribe (SpeechAnalyzer macOS 26+ ou SFSpeechRecognizer fallback)
  // engine: "sa|sf|auto" (default auto); locale: BCP47 (e.g. "pt-BR", "en-US")
  async aspTranscribe(absPath, locale = 'pt-BR', engine = 'auto') {
    return await this._post('/v1/asp/transcribe',
      { path: absPath, locale, engine },
      600000  // 10min para áudios longos + asset download primeira vez
    );
  }

  // v1.3.0 — asp vad (Voice Activity Detection rápido, pré-filtro)
  async aspVad(absPath) {
    return await this._post('/v1/asp/vad', { path: absPath }, 15000);
  }

  async embedBatch(texts, options = {}) {
    // v1.5 — daemon /v1/embed só aceita single `text`. Antes da v1.5 isso caía
    // no fallback `afm embed` CLI que recebia stdin batch; removido o CLI,
    // implementamos batch via N chamadas sequenciais. Para vault grande, manter
    // throughput aceitável (~20ms/embed no M2 Pro local) — caller costuma usar
    // BATCH=20 já. Eventualmente daemon ganha `{texts:[...]}` nativo.
    if (!Array.isArray(texts)) {
      throw new Error('embedBatch: requer array de strings');
    }
    const { _privacyPath, privacyPath, privacy, ...wireOptions } = options || {};
    const privacyCtx = { _privacyPath: _privacyPath || privacyPath, privacy };
    const vectors = [];
    let dim = 0, model = '';
    for (const t of texts) {
      const r = await this._post('/v1/embed', { text: t, ...wireOptions }, 30000, privacyCtx);
      const v = (r.vectors && r.vectors[0]) || r.vector;
      if (!Array.isArray(v)) throw new Error('embedBatch: daemon não retornou vetor para "' + (t || '').slice(0, 40) + '..."');
      vectors.push(v);
      if (!dim) { dim = r.dim || v.length; model = r.model || ''; }
    }
    return { vectors, dim, model, count: vectors.length };
  }

  async enrich(noteContent, notePath, vaultSummary = '') {
    return await this._post('/v1/enrich', {
      note_content: noteContent,
      note_path: notePath,
      vault_summary: vaultSummary,
    }, 90000);
  }

  async agent(question, pattern = 'auto') {
    return await this._post('/v1/agent', { question, pattern }, 180000);
  }

  async ocr(filePath, outputFormat = 'text', language = 'pt-BR,en') {
    // v1.5 — daemon /v1/ocr handler exige `image_path` (ou `image_base64`).
    // Pré-v1.5 cliente enviava `path` que caía no CLI fallback; agora precisa
    // bater no contrato Swift exato. `output_format` e `language` ignorados
    // server-side mas mantidos por compat futura.
    const langArr = typeof language === 'string'
      ? language.split(',').map(s => s.trim()).filter(Boolean)
      : (Array.isArray(language) ? language : ['pt-BR', 'en-US']);
    return await this._post('/v1/ocr', {
      image_path: filePath,
      languages: langArr,
      output_format: outputFormat,
    }, 120000);
  }

  // v1.15 — codex round 5: privacyCtx ({_privacyPath, privacy}) propaga a
  // proveniência do conteúdo já extraído para o gate central em _post. Sem isso,
  // texto vindo de Clientes/** escaparia por endpoints content-only (sem path no body).
  async summarize(text, privacyCtx = null) {
    return await this._post('/v1/summarize', { text }, 60000, privacyCtx);
  }

  async graphExtract(text, maxNodes = 20, maxEdges = 30, privacyCtx = null) {
    return await this._post('/v1/graph/extract', { text, max_nodes: maxNodes, max_edges: maxEdges }, 60000, privacyCtx);
  }

  async classify(text, options, privacyCtx = null) {
    return await this._post('/v1/classify', { text, options }, 60000, privacyCtx);
  }

  async prompt(instruction, options = {}) {
    // options: { max_tokens, deterministic, prewarm, _privacyPath, privacy }
    const body = {
      instruction,
      max_tokens: options.max_tokens || 300,
      deterministic: options.deterministic !== false,
    };
    if (options.prewarm !== undefined) body.prewarm = options.prewarm;
    return await this._post('/v1/prompt', body, options.timeoutMs || 90000,
      { _privacyPath: options._privacyPath || options.privacyPath, privacy: options.privacy });
  }

  async visionClassify(imagePath, topN = 8) {
    return await this._post('/v1/vision/classify', { path: imagePath, top_n: topN }, 30000);
  }

  async visionLandmarks(imagePath) {
    return await this._post('/v1/vision/landmarks', { path: imagePath }, 30000);
  }

  // ----- v0.7 new methods — full Apple ecosystem coverage -----

  async translate(text, sourceLang, targetLang) {
    return await this._post('/v1/translate', { text, source_lang: sourceLang, target_lang: targetLang }, 30000);
  }

  async nlTag(text, scheme = 'lemma') {
    return await this._post('/v1/nl/tag', { text, scheme }, 15000);
  }

  async nlSentiment(text) {
    return await this._post('/v1/nl/sentiment', { text }, 15000);
  }

  async nlLanguageDetect(text, topN = 3) {
    return await this._post('/v1/nl/language-detect', { text, top_n: topN }, 10000);
  }

  async visionSaliency(imagePath, mode = 'attention') {
    return await this._post('/v1/vision/saliency', { path: imagePath, mode }, 30000);
  }

  async visionFeaturePrint(imagePath) {
    return await this._post('/v1/vision/feature-print', { path: imagePath }, 30000);
  }

  async visionAesthetics(imagePath) {
    return await this._post('/v1/vision/aesthetics', { path: imagePath }, 30000);
  }

  async visionBarcode(imagePath) {
    return await this._post('/v1/vision/barcode', { path: imagePath }, 30000);
  }

  async visionDocument(imagePath) {
    return await this._post('/v1/vision/document', { path: imagePath }, 60000);
  }

  async dataDetect(text) {
    return await this._post('/v1/data-detect', { text }, 10000);
  }

  async spotlightSearch(query, scope = null, limit = 50) {
    return await this._post('/v1/spotlight/search', { query, scope, limit }, 15000);
  }

  // v1.7 — Spotlight via CSSearchableIndex programático (requer daemon ≥ v1.7,
  // ativa após `node scripts/build-release.mjs`). Cliente prefere este endpoint
  // mas faz fallback gracioso para `/v1/spotlight/search` (mdfind shell) quando
  // o daemon bundled ainda for v1.0.0 (HTTP 404).
  //
  // mode: 'spotlight' | 'stale' | 'unindexed' | 'mdfind-fallback' | 'error'
  // (padrão inspirado em maiocchi-ia/skills/tripla-fusao/scripts/bm25.py
  //  — fallback honesto declarado em vez de scores silenciosos vazios)
  async spotlightQueryNative(query, scope = null, limit = 50, domainHint = null) {
    let resolvedDomainHint = domainHint;
    if (!resolvedDomainHint && scope) {
      try {
        const hex = await universal.sha256Hex(scope);
        resolvedDomainHint = 'com.maiocchi.zeus.' + hex.slice(0, 16);
      } catch {}
    }
    const body = { query, scope, limit };
    if (resolvedDomainHint) body.domain_hint = resolvedDomainHint;
    try {
      const r = await this._post('/v1/spotlight/query', body, 15000);
      return { ...r, mode: 'spotlight' };
    } catch (e) {
      const nativeMessage = e.message || String(e);
      if (/domain_hint obrigat[oó]rio|unsupported_on_aegis_daemon/i.test(nativeMessage)) {
        return { mode: 'error', error: nativeMessage, results: [] };
      }
      // Daemon bundled v1.0.0 retorna 404 com payload {path,method,available}
      // (sem campo `error`), o que faz _post lançar string genérica. Em vez de
      // tentar matchar a forma exata da mensagem, fallback gracioso pra mdfind
      // sempre que o endpoint nativo falha — mdfind é o caminho legacy estável.
      try {
        const r = await this.spotlightSearch(query, scope, limit);
        return { ...r, mode: 'mdfind-fallback', native_error: nativeMessage.slice(0, 200) };
      } catch (e2) {
        return { mode: 'error', error: e2.message, native_error: nativeMessage, results: [] };
      }
    }
  }

  async spotlightIndex(items, domainHint = null) {
    // Aceita array de {path, title, summary, keywords, mtime}. Daemon ≥ v1.7
    // converte em CSSearchableItem batch.
    return await this._post('/v1/spotlight/index', { items, domain_hint: domainHint }, 60000);
  }

  async spotlightPurge(domainHint = null) {
    return await this._post('/v1/spotlight/purge', { domain_hint: domainHint }, 15000);
  }

  // ----- v0.9 new methods — Passport Index Architecture (PIA) -----
  // MCP-first surface for agent consumption with progressive disclosure.

  /**
   * Extract a single passport (concepts + summary + domain + difficulty) for a note.
   * Daemon uses Apple NLTagger (nameType+lemma) + afm summarize + afm classify.
   */
  async passportExtract(notePath, domainOptions = []) {
    return await this._post('/v1/passport/extract', {
      path: notePath,
      domain_options: domainOptions,
    }, 30000);
  }

  /**
   * Batch extract passports for many notes in one daemon call.
   * Long timeout (10min) — vault-wide rebuild can take a while.
   */
  async passportBatchExtract(notePaths, domainOptions = []) {
    return await this._post('/v1/passport/batch-extract', {
      paths: notePaths,
      domain_options: domainOptions,
    }, 600000);
  }

  /**
   * Find passports semantically relevant to a query.
   * Combines embeddings cosine (over embeddings.jsonl) + concept-match scoring
   * (over passports.jsonl). Returns top-N passports WITHOUT raw content —
   * token-efficient first probe for agents.
   *
   * @param {string} query
   * @param {object} options
   *   - embeddingsPath: path to embeddings.jsonl
   *   - passportsPath:  path to passports.jsonl
   *   - topN:           number of results (default 10)
   *   - minScore:       cosine threshold (default 0.3)
   *   - conceptFilter:  array of concepts to require in result
   */
  async passportFind(query, options = {}) {
    return await this._post('/v1/passport/find', {
      query,
      embeddings_jsonl_path: options.embeddingsPath,
      passports_jsonl_path: options.passportsPath,
      top_n: options.topN || 10,
      min_score: options.minScore || 0.3,
      concept_filter: options.conceptFilter || null,
    }, 30000);
  }

  /**
   * Fetch raw markdown content for a specific note.
   * Agents call this ONLY after passport lookup indicates this note is needed
   * for deep-dive. max_chars caps payload to prevent context blow-up.
   */
  async contentGet(filePath, vaultRoot, maxChars = 50000) {
    return await this._post('/v1/content/get', {
      path: filePath,
      vault_root: vaultRoot,
      max_chars: maxChars,
    }, 15000);
  }

  async health() {
    const resp = await this._requestUrl({
      url: `${this.baseUrl}/v1/health`,
      method: 'GET',
      throw: false,
    });
    return resp.json || { status: 'unreachable' };
  }

  async tools() {
    const resp = await this._requestUrl({
      url: `${this.baseUrl}/v1/tools`,
      method: 'GET',
      throw: false,
    });
    return (resp.json && resp.json.tools) || [];
  }

  // v1.9 — MobileCLIP stub opt-in (ADR-010)
  //
  // Sem modelo instalado em ~/Library/Application Support/Zeus/mobileclip-model/
  // o daemon retorna 501 com `hint` acionável apontando para o comando do plugin
  // "Zeus: instalar modelo MobileCLIP (download manual)". Runtime CoreML real
  // chega em v2.0.
  async mobileclipStatus() {
    try {
      const resp = await this._requestUrl({
        url: `${this.baseUrl}/v1/mobileclip/status`,
        method: 'GET',
        throw: false,
      });
      return resp.json || { error: 'unreachable' };
    } catch (e) {
      return { error: e.message };
    }
  }

  async mobileclipEmbedImage(imagePath) {
    return await this._post('/v1/mobileclip/embed-image', { image_path: imagePath }, 60000);
  }

  async mobileclipEmbedText(text) {
    return await this._post('/v1/mobileclip/embed-text', { text }, 30000);
  }
}

module.exports = ZeusHttpClient;
