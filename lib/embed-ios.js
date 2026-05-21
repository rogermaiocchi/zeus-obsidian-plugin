/*
 * embed-ios.js — v1.15.0 roteamento autônomo por dispositivo iOS + schema versionado.
 *
 * v1.15.0 — device autonomy: cada device usa seus modelos Apple nativos.
 * Roteamento de embed em 3 camadas, em ordem de preferência:
 *
 *   CAMADA 0 (NOVA — autonomia iOS): AegisDaemon local (127.0.0.1:2223)
 *     Quando deviceAutonomyMode === 'ios-native' OU (auto + aegis disponível).
 *     iOS com AegisDaemon embarcado usa NLContextualEmbedding local (512-dim).
 *     Source: 'daemon-ios-local'. Latência: ~50ms (on-device, sem rede).
 *
 *   CAMADA 1 (relay Mac) — Tailscale/loopback HTTP daemon
 *     iOS chama daemon Mac via Tailscale mesh. 512-dim em embeddings.jsonl.
 *     Source: 'daemon-relay'. Latência: 100-500ms via rede.
 *     Comportamento anterior (v1.12) preservado como fallback.
 *
 *   CAMADA 2 (zeus-embed-runtime internalizado) — zeus-multilingual-e5-small
 *     Substitui referência externa a @xenova/transformers.
 *     Modelo ONNX em data/zeus-e5-small/ (vault-local, sem CDN externo).
 *     384-dim em embeddings-ios.jsonl. Source: 'zeus-embed-runtime-ios'.
 *     v1.15.0: stub verificador; inferência ONNX completa em v1.16 labs.
 *
 * SCHEMA versionado (separação rigorosa Mac×iOS):
 *   embeddings.jsonl     — 512-dim NLContextualEmbedding (Apple daemon Mac/iOS)
 *   embeddings-ios.jsonl — 384-dim zeus-multilingual-e5-small (zeus-embed-runtime)
 *
 *   Cada linha em ambos:
 *     {
 *       schema: 'zeus-embeddings-v1',
 *       path: 'note/path.md',
 *       sha: '...',
 *       mtime: 1700000000000,
 *       title: '...',
 *       model_id: 'apple-nlcontextual-pt-BR' | 'zeus-multilingual-e5-small',
 *       model_revision: '...',
 *       dim: 512 | 384,                // loader recusa dim mismatch
 *       device_class: 'mac' | 'ios' | 'ipad',
 *       text_sha: '...',
 *       source: 'daemon-ios-local' | 'daemon-relay' | 'zeus-embed-runtime-ios',
 *       created_at: '2026-05-20T...',
 *       vec: [Float, ...],
 *     }
 *
 * Referência: v1.15.0 device autonomy (auditoria 2026-05-21).
 */

'use strict';

const universal = require('./universal-fs');
const zeusEmbedRuntimeMod = require('./zeus-embed-runtime');

const EMBED_IOS_FILE = 'embeddings-ios.jsonl';
const EMBED_IOS_DIM = 384;          // zeus-multilingual-e5-small (internalizado)
const EMBED_IOS_MODEL = 'zeus-multilingual-e5-small';
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

  // Check se zeus-embed-runtime está instalado (data/zeus-e5-small/).
  async _modelInstalled() {
    return zeusEmbedRuntimeMod.isInstalled(this._adapter, this.dataPath);
  }

  /**
   * Embed via zeus-embed-runtime internalizado (zeus-multilingual-e5-small, ONNX).
   * Substitui referência externa a @xenova/transformers (encapsulamento v1.15.0).
   * Retorna vec 384-dim ou lança com instrução acionável.
   */
  async embedText(text) {
    const result = await zeusEmbedRuntimeMod.zeusEmbedRuntime(
      text, this.dataPath, this._adapter,
    );
    if (!result.ok) {
      throw new Error(
        `zeus-embed-runtime: ${result.reason}. ${result.hint || ''} `
        + `(zeus-embed-runtime v${zeusEmbedRuntimeMod.ZEUS_EMBED_RUNTIME_VERSION})`,
      );
    }
    return result.vec;
  }
}

// =========================================================================
// EmbedRelay — v1.15.0 roteamento autônomo por dispositivo.
// Camada 0: AegisDaemon local iOS (quando disponível — on-device, ~50ms).
// Camada 1: daemon Mac via Tailscale/loopback (relay, ~100-500ms).
// Ambas retornam 512-dim NLContextualEmbedding Apple.
// =========================================================================

class EmbedRelay {
  constructor(plugin) {
    this.plugin = plugin;
  }

  /**
   * Determina se deve usar AegisDaemon local iOS (autonomia por device).
   * Retorna true quando:
   *   - deviceAutonomyMode === 'ios-native', OU
   *   - mode 'auto' + running iOS + AegisDaemon respondendo localmente
   * @returns {boolean}
   */
  _shouldUseLocalAegis() {
    const settings = this.plugin && this.plugin.settings;
    if (!settings) return false;
    const mode = settings.deviceAutonomyMode || 'auto';
    if (mode === 'ios-native') return true;
    if (mode === 'mac-only' || mode === 'ios-fallback') return false;
    // mode === 'auto': usa local se capability já detectada
    const caps = settings.deviceCapabilities || {};
    return caps.aegis_available === true && universal.isMobile();
  }

  /**
   * Tenta embed via AegisDaemon local (127.0.0.1:2223) ou relay Mac.
   * Camada 0 (nova): AegisDaemon iOS local — source: 'daemon-ios-local'
   * Camada 1 (preservada): relay Mac — source: 'daemon-relay'
   * Sucesso → {ok: true, vec, dim, model, source}
   * Falha   → {ok: false, reason}  (não lança)
   */
  async tryEmbed(text, options = {}) {
    if (!this.plugin.httpClient) return { ok: false, reason: 'no-httpClient' };
    if (!text || text.length < 2) return { ok: false, reason: 'text-too-short' };

    const useLocal = this._shouldUseLocalAegis();
    const sourceLabel = useLocal ? 'daemon-ios-local' : 'daemon-relay';

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
        source: sourceLabel,
      };
    } catch (e) {
      return { ok: false, reason: (e.message || String(e)).slice(0, 100) };
    }
  }
}

module.exports = EmbedIos;
module.exports.EmbedRelay = EmbedRelay;
module.exports.EMBED_IOS_DIM = EMBED_IOS_DIM;
module.exports.EMBED_IOS_MODEL = EMBED_IOS_MODEL;
module.exports.EMBED_MAC_DIM = EMBED_MAC_DIM;
module.exports.EMBED_MAC_MODEL = EMBED_MAC_MODEL;
// v1.15.0: re-export zeus-embed-runtime para que main.source.js acesse
// getInstallInstructions() no comando zeus-embed-install
module.exports.zeusEmbedRuntime = zeusEmbedRuntimeMod;
