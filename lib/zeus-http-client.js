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
 *   POST /v1/graph-extract          body: {text}
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

    // v2.0 — Apple Cloud Private (PCC) routing
    // pccMode: 'off' | 'opt-in' | 'auto'
    //   'off'    → no PCC header sent; daemon constrained to on-device
    //   'opt-in' → header X-Zeus-Allow-Pcc:1; daemon decides per request
    //   'auto'   → header X-Zeus-Allow-Pcc:auto; daemon routes to PCC when on-device exceeds
    this.pccMode = 'off';
    this.lastPccUsed = false;          // updated from response header X-Zeus-Pcc-Used
    this.pccUsageCount = 0;            // total PCC-routed requests since startup
  }

  setPccMode(mode) {
    const valid = ['off', 'opt-in', 'auto'];
    this.pccMode = valid.includes(mode) ? mode : 'off';
  }

  getPccStatus() {
    return {
      mode: this.pccMode,
      lastUsed: this.lastPccUsed,
      totalUsageCount: this.pccUsageCount,
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

  // Lazy health check — cached for HEALTH_TTL_MS
  async isAvailable() {
    const now = Date.now();
    if (this.healthCache !== null && (now - this.healthCheckedAt) < this.HEALTH_TTL_MS) {
      return this.healthCache;
    }
    try {
      const resp = await this._requestUrl({
        url: `${this.baseUrl}/v1/health`,
        method: 'GET',
        throw: false,
      });
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
  // Daemon sets `X-Zeus-Pcc-Used: 1` when the request was routed via Private Cloud Compute.
  _readPccUsed(headers) {
    if (!headers) return false;
    // Obsidian requestUrl returns headers as plain object; fetch returns Headers instance
    const val = typeof headers.get === 'function'
      ? headers.get('x-zeus-pcc-used') || headers.get('X-Zeus-Pcc-Used')
      : (headers['x-zeus-pcc-used'] || headers['X-Zeus-Pcc-Used']);
    const used = val === '1' || val === 'true';
    if (used) this.pccUsageCount++;
    this.lastPccUsed = used;
    return used;
  }

  // Try to load Obsidian's requestUrl from the obsidian module; fallback to fetch on Node
  async _requestUrl({ url, method = 'GET', body, contentType = 'application/json', throw: throwOnError = true }) {
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
      this._readPccUsed(resp.headers);
      return resp;
    }

    // Node fallback (testing, scripts)
    if (typeof fetch === 'function') {
      const resp = await fetch(url, {
        method,
        headers: { 'Content-Type': contentType, ...pccHeaders },
        body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      });
      this._readPccUsed(resp.headers);
      const text = await resp.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: resp.status, text, json, headers: resp.headers };
    }

    throw new Error('Nenhum transporte HTTP disponível (sem obsidian.requestUrl, sem fetch)');
  }

  async _post(endpoint, body, timeoutMs = 60000) {
    const ctrl = new (typeof AbortController !== 'undefined' ? AbortController : class { constructor(){this.signal=null;} abort(){} })();
    const timer = setTimeout(() => ctrl.abort && ctrl.abort(), timeoutMs);
    // v0.9 — instrument bytes-out (request payload)
    const bodyStr = typeof body === 'string' ? body : (body ? JSON.stringify(body) : '');
    const bytesOut = bodyStr ? universal.byteLength(bodyStr) : 0;
    try {
      const resp = await this._requestUrl({
        url: `${this.baseUrl}${endpoint}`,
        method: 'POST',
        body: bodyStr,
      });
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
    // Returns { vectors: [[...]], dim, model, count }
    return await this._post('/v1/embed', { text, ...options });
  }

  // v1.3.0 — afm refine (Writing Tools nativo)
  // mode: "proofread|rewrite|simplify"; tone para rewrite: "academic|professional|casual"
  async refine(text, mode = 'proofread', options = {}) {
    return await this._post('/v1/afm/refine', { text, mode, ...options }, 90000);
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
    // Daemon expects `text` as string OR array — adapt as needed
    return await this._post('/v1/embed', { texts, ...options }, 120000);
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
    return await this._post('/v1/ocr', {
      path: filePath, output_format: outputFormat, language,
    }, 120000);
  }

  async summarize(text) {
    return await this._post('/v1/summarize', { text }, 60000);
  }

  async graphExtract(text, maxNodes = 20, maxEdges = 30) {
    return await this._post('/v1/graph-extract', { text, max_nodes: maxNodes, max_edges: maxEdges }, 60000);
  }

  async classify(text, options) {
    return await this._post('/v1/classify', { text, options }, 60000);
  }

  async prompt(instruction, options = {}) {
    // options: { max_tokens, deterministic, prewarm }
    const body = {
      instruction,
      max_tokens: options.max_tokens || 300,
      deterministic: options.deterministic !== false,
    };
    if (options.prewarm !== undefined) body.prewarm = options.prewarm;
    return await this._post('/v1/prompt', body, options.timeoutMs || 90000);
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
}

module.exports = ZeusHttpClient;
