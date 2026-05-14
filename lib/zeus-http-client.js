/*
 * ZeusHttpClient — daemon HTTP transport (v0.7 padrão Aegis — full Apple ecosystem)
 *
 * Cliente HTTP que fala com daemon Swift nativo rodando em 127.0.0.1:2223
 * (ou Tailscale cross-device). Substitui o child_process.spawn no hot path
 * quando o daemon está disponível; faz fallback gracioso para spawn caso contrário.
 *
 * Mesmo código funciona em Mac, iPhone, iPad — porque usa Obsidian's
 * requestUrl API (bypass CORS oficial em mobile + Electron).
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

class ZeusHttpClient {
  constructor(baseUrl) {
    this.baseUrl = (baseUrl || 'http://127.0.0.1:2223').replace(/\/$/, '');
    this.healthCache = null;
    this.healthCheckedAt = 0;
    this.HEALTH_TTL_MS = 30000;   // re-probe daemon health every 30s
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

  // Try to load Obsidian's requestUrl from the obsidian module; fallback to fetch on Node
  async _requestUrl({ url, method = 'GET', body, contentType = 'application/json', throw: throwOnError = true }) {
    let obsidian;
    try { obsidian = require('obsidian'); } catch { obsidian = null; }

    if (obsidian && obsidian.requestUrl) {
      // Obsidian environment — preferred
      return await obsidian.requestUrl({
        url, method, contentType,
        body: typeof body === 'string' ? body : (body ? JSON.stringify(body) : undefined),
        throw: throwOnError,
      });
    }

    // Node fallback (testing, scripts)
    if (typeof fetch === 'function') {
      const resp = await fetch(url, {
        method,
        headers: { 'Content-Type': contentType },
        body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      });
      const text = await resp.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      return { status: resp.status, text, json };
    }

    throw new Error('Nenhum transporte HTTP disponível (sem obsidian.requestUrl, sem fetch)');
  }

  async _post(endpoint, body, timeoutMs = 60000) {
    const ctrl = new (typeof AbortController !== 'undefined' ? AbortController : class { constructor(){this.signal=null;} abort(){} })();
    const timer = setTimeout(() => ctrl.abort && ctrl.abort(), timeoutMs);
    try {
      const resp = await this._requestUrl({
        url: `${this.baseUrl}${endpoint}`,
        method: 'POST',
        body,
      });
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
