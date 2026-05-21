/*
 * embed-ios.js — iOS embed schema versionado + embed via daemon LOCAL.
 *
 * v1.15 — arquitetura ON-DEVICE pura (sem relay). Two-tier:
 *
 *   CAMADA 1 — daemon Apple-nativo LOCAL (loopback). No Mac, o daemon local
 *     (ZeusDaemonMac, auto-spawn) computa NLContextualEmbedding 512-dim e
 *     persiste em data/embeddings.jsonl, que sincroniza via iCloud. No iOS não
 *     há daemon (sandbox) → o índice já vem pronto do Mac via sync; a busca usa
 *     as lanes JS. Sem Tailscale, sem rota remota.
 *
 *   CAMADA 2 (opt-in labs, default OFF) — transformers.js + multilingual-e5-small
 *     ~118MB lazy-fetch via huggingface.co em primeiro use. Cache via Browser
 *     Cache API (NÃO IndexedDB — codex notou: Transformers.js usa env.useBrowserCache).
 *     Persiste em data/embeddings-ios.jsonl (384-dim, schema separado).
 *     Quality: e5 multilingual ~80% NLContextualEmbedding pt-BR. Latência:
 *     500-1500ms via WASM no WKWebView.
 *     v1.12 ENTREGA: stub + comando "instalar modelo" (copia instruções pro
 *     clipboard estilo MobileCLIP v1.9). Integração runtime transformers.js
 *     deferida pra ADR-011 v1.13 labs (precisa bundle config + CSP audit real).
 *
 * SCHEMA versionado (codex MED — separação rigorosa Mac×iOS):
 *   embeddings.jsonl  — 512-dim NLContextualEmbedding (Apple Mac/iOS daemon)
 *   embeddings-ios.jsonl — 384-dim multilingual-e5-small (transformers.js iOS)
 *
 *   Cada linha em ambos:
 *     {
 *       schema: 'zeus-embeddings-v1',
 *       path: 'note/path.md',
 *       sha: '...',
 *       mtime: 1700000000000,
 *       title: '...',
 *       model_id: 'apple-nlcontextual-pt-BR' | 'Xenova/multilingual-e5-small',
 *       model_revision: '...',         // commit/tag do modelo
 *       dim: 512 | 384,                // recusa carregar se mismatch
 *       device_class: 'mac' | 'ios' | 'ipad',
 *       text_sha: '...',               // hash do texto embedado (não do file)
 *       source: 'daemon-mac' | 'daemon-local' | 'transformers-ios',
 *       created_at: '2026-05-20T...',
 *       vec: [Float, ...],
 *     }
 *
 * RRF cross-dim: HybridSearch fuse() usa rank position (não cosine cross-dim),
 * portanto seguro adicionar embeddings-ios como 7º retriever desde que cada
 * device leia SÓ seu próprio jsonl (loader recusa dim mismatch).
 */

'use strict';

const universal = require('./universal-fs');

const EMBED_IOS_FILE = 'embeddings-ios.jsonl';
const EMBED_IOS_DIM = 384;          // multilingual-e5-small
const EMBED_IOS_MODEL = 'Xenova/multilingual-e5-small';
const EMBED_MAC_DIM = 512;          // NLContextualEmbedding
const EMBED_MAC_MODEL = 'apple-nlcontextual-pt-BR';

class EmbedIos {
  constructor(plugin) {
    this.plugin = plugin;
    this._entries = new Map();        // path → entry
    this._loaded = false;
    this._writePromise = null;        // mutex
  }

  get _adapter() { return this.plugin.app.vault.adapter; }
  get dataPath() { return universal.joinPath(this.plugin.manifest.dir, 'data'); }
  get jsonlPath() { return universal.joinPath(this.dataPath, EMBED_IOS_FILE); }

  async load() {
    if (this._loaded) return;
    if (!(await universal.adapterExists(this._adapter, this.jsonlPath))) {
      this._loaded = true;
      return;
    }
    try {
      const raw = await universal.adapterRead(this._adapter, this.jsonlPath);
      for (const line of raw.split('\n').filter(Boolean)) {
        try {
          const obj = JSON.parse(line);
          // codex MED: loader recusa dim mismatch (não truncar silente).
          if (!obj || !obj.path) continue;
          if (obj.dim !== EMBED_IOS_DIM) {
            console.warn('[zeus.embed-ios] skip linha dim mismatch:', obj.path, 'dim=', obj.dim);
            continue;
          }
          if (!Array.isArray(obj.vec) || obj.vec.length !== EMBED_IOS_DIM) {
            console.warn('[zeus.embed-ios] skip linha vec inválida:', obj.path);
            continue;
          }
          this._entries.set(obj.path, obj);
        } catch (e) { /* skip malformed */ }
      }
    } catch (e) {
      console.warn('[zeus.embed-ios] load failed:', e.message);
    }
    this._loaded = true;
  }

  // Get entry por path (iOS-local 384-dim).
  async get(path) {
    await this.load();
    return this._entries.get(path) || null;
  }

  // Persist atomic. Mutex serializa concorrentes (v1.8.1 pattern).
  async _persist() {
    if (this._writePromise) await this._writePromise.catch(() => {});
    this._writePromise = (async () => {
      try {
        await universal.adapterMkdir(this._adapter, this.dataPath);
        const lines = [];
        for (const e of this._entries.values()) lines.push(JSON.stringify(e));
        await universal.adapterWriteAtomic(this._adapter, this.jsonlPath, lines.join('\n'));
      } finally {
        this._writePromise = null;
      }
    })();
    return this._writePromise;
  }

  // Upsert entry. Validate schema + dim.
  async upsert(entry) {
    await this.load();
    if (!entry || !entry.path) throw new Error('embed-ios.upsert: path obrigatório');
    if (entry.dim !== EMBED_IOS_DIM) throw new Error(`embed-ios.upsert: dim ${entry.dim} ≠ ${EMBED_IOS_DIM}`);
    if (!Array.isArray(entry.vec) || entry.vec.length !== EMBED_IOS_DIM) {
      throw new Error('embed-ios.upsert: vec inválido');
    }
    // Garante schema fields obrigatórios
    entry.schema = entry.schema || 'zeus-embeddings-v1';
    entry.model_id = entry.model_id || EMBED_IOS_MODEL;
    entry.created_at = entry.created_at || new Date().toISOString();
    entry.source = entry.source || 'transformers-ios';
    this._entries.set(entry.path, entry);
    await this._persist();
    return { upserted: entry.path, total: this._entries.size };
  }

  // Removes entry (note deleted/renamed)
  async remove(path) {
    await this.load();
    if (this._entries.has(path)) {
      this._entries.delete(path);
      await this._persist();
      return { removed: true };
    }
    return { removed: false };
  }

  // Stats
  async stats() {
    await this.load();
    return {
      schema: 'zeus-embeddings-v1',
      file: this.jsonlPath,
      model_id: EMBED_IOS_MODEL,
      dim: EMBED_IOS_DIM,
      count: this._entries.size,
      runtime_installed: await this._modelInstalled(),
    };
  }

  // Check se transformers.js + modelo estão instalados (cache local)
  async _modelInstalled() {
    // v1.12: detecção stub — checa se ~/.zeus-ios-embed-model/ existe no
    // application support (futuro v1.13 labs gravará aqui após primeiro fetch).
    // Por enquanto sempre retorna false (sem runtime instalado).
    return false;
  }

  /**
   * Embed um texto via transformers.js (lazy-load).
   * v1.12 ENTREGA: stub que retorna instrução acionável quando runtime ausente.
   * v1.13 labs implementará lazy-import xenova/transformers + modelo fetch.
   */
  async embedText(text) {
    if (!(await this._modelInstalled())) {
      throw new Error(
        'embed-ios runtime não instalado. Rode comando "Zeus: instalar modelo iOS embed". '
        + 'v1.12 ENTREGA é stub; runtime transformers.js completo em v1.13 labs (ADR-011).',
      );
    }
    // TODO v1.13: const { pipeline } = await import('@xenova/transformers');
    //             const ext = await pipeline('feature-extraction', EMBED_IOS_MODEL, { quantized: true });
    //             const out = await ext('query: ' + text, { pooling: 'mean', normalize: true });
    //             return Array.from(out.data);
    throw new Error('embed-ios.embedText: runtime não implementado em v1.12');
  }
}

// =========================================================================
// LocalDaemonEmbed — embed via daemon Apple-nativo LOCAL (loopback).
// v1.15: on-device puro. No Mac, o httpClient fala com o ZeusDaemonMac local
// (127.0.0.1, auto-spawn) → NLContextualEmbedding 512-dim. No iOS não há daemon
// (sandbox) → tryEmbed retorna {ok:false, reason:'daemon-unreachable'} gracioso,
// e a busca cai nas lanes JS. Sem relay/Tailscale.
// =========================================================================

class LocalDaemonEmbed {
  constructor(plugin) {
    this.plugin = plugin;
  }

  /**
   * Tenta embed via daemon HTTP LOCAL (loopback).
   * Sucesso → retorna {ok: true, vec, dim, model, source}
   * Falha → retorna {ok: false, reason}  (não lança — gracioso)
   */
  async tryEmbed(text, options = {}) {
    if (!this.plugin.httpClient) return { ok: false, reason: 'no-httpClient' };
    if (!text || text.length < 2) return { ok: false, reason: 'text-too-short' };
    try {
      const available = await this.plugin.httpClient.isAvailable(1500);
      if (!available) return { ok: false, reason: 'daemon-unreachable' };
      const r = await this.plugin.httpClient.embed(text, options);
      const vec = (r && r.vectors && r.vectors[0]) || (r && r.vector) || null;
      if (!Array.isArray(vec) || vec.length !== EMBED_MAC_DIM) {
        return { ok: false, reason: `dim-mismatch: ${vec ? vec.length : 'null'}` };
      }
      return {
        ok: true,
        vec,
        dim: EMBED_MAC_DIM,
        model: (r && r.model) || EMBED_MAC_MODEL,
        source: 'daemon-local',
      };
    } catch (e) {
      return { ok: false, reason: (e.message || String(e)).slice(0, 100) };
    }
  }
}

module.exports = EmbedIos;
module.exports.LocalDaemonEmbed = LocalDaemonEmbed;
module.exports.EMBED_IOS_DIM = EMBED_IOS_DIM;
module.exports.EMBED_IOS_MODEL = EMBED_IOS_MODEL;
module.exports.EMBED_MAC_DIM = EMBED_MAC_DIM;
module.exports.EMBED_MAC_MODEL = EMBED_MAC_MODEL;
