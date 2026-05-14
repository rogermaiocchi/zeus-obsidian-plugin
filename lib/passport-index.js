/*
 * PassportIndex — Camada 2 (Passport Index Architecture / PIA)
 *
 * Cada nota tem um "passport" extraído por Apple NLTagger (concepts via nameType+lemma)
 * + afm summarize (one_line_summary) + afm classify (domain) + heuristica (difficulty).
 *
 * Sources autoritativos (em ordem de hierarquia):
 *   1. data/passports.jsonl       — CANÔNICO. MCP consumes this.
 *   2. data/zeus-cards.base       — UI derivative do Obsidian Bases, gerado do JSONL.
 *   3. Frontmatter `zeus_related` — graph nativo Obsidian (já existe em v0.8.0).
 *
 * Token economics:
 *   - Naive RAG: cosine top-5 com conteúdo completo (~25KB) ao LLM context.
 *   - PIA:      find_relevant_notes (top-N passports, ~3KB) → LLM decide deep-dive
 *               → get_content só para 1-2 notas (~5-15KB total).
 *   - Savings:  60-80% em tokens para queries típicas.
 *
 * Persistência (JSONL canônico — 1 linha por nota):
 *   {"path":"20_Arquitetura/Aegis.md","concepts":["Tailscale","SwiftNIO"],
 *    "one_line_summary":"...","domain":["Tech"],"difficulty":3,"sha":"abc",
 *    "extracted_at":"2026-05-14T..."}
 *
 * v0.11 — universal (Mac+iOS): substituído fs/path/crypto por lib/universal-fs +
 * vault.adapter. Métodos viraram async.
 *
 * Referência: ADR-018, brainstorm session 2026-05-14 (PIA architecture).
 */

'use strict';

const universal = require('./universal-fs');

const PASSPORTS_FILE = 'passports.jsonl';
const DATA_DIR_NAME = 'data';

class PassportIndex {
  constructor(plugin) {
    this.plugin = plugin;
    this._cache = null;          // Map<path, passport>
    this._cacheLoadedAt = 0;
    this._lastBuiltAt = null;
  }

  // ---- Path helpers (vault-relative) ----

  get _adapter() {
    return this.plugin.app.vault.adapter;
  }

  get dataPath() {
    return universal.joinPath(this.plugin.manifest.dir, DATA_DIR_NAME);
  }

  get jsonlPath() {
    return universal.joinPath(this.dataPath, PASSPORTS_FILE);
  }

  async _ensureDataDir() {
    await universal.adapterMkdir(this._adapter, this.dataPath);
  }

  // ---- Build / extract operations ----

  /**
   * Extract passport for a single note.
   * Calls daemon /v1/passport/extract.
   * Returns the passport object (also persisted to JSONL).
   *
   * v0.10: passport gains `sha` (sha256 of file content at extraction time),
   * `extracted_by` (device_id from coordinator) and `extracted_at` (ISO timestamp)
   * for cross-device staleness detection via PassportScheduler.
   */
  async buildOne(filePath, domainOptions = []) {
    if (!this.plugin.httpClient) {
      throw new Error('PassportIndex.buildOne: httpClient indisponível');
    }
    // Compute current SHA before daemon call so we can attach it to the passport
    // even if the daemon doesn't return one.
    let currentSha = null;
    try {
      if (await universal.adapterExists(this._adapter, filePath)) {
        const content = await universal.adapterRead(this._adapter, filePath);
        currentSha = await universal.sha256Hex(content);
      }
    } catch (e) {
      console.warn('[zeus][passport] sha precompute failed for', filePath, e.message);
    }
    const passport = await this.plugin.httpClient.passportExtract(filePath, domainOptions);
    if (!passport || !passport.path) {
      throw new Error(`PassportIndex.buildOne: resposta inválida para ${filePath}`);
    }
    // Stamp staleness-tracking fields (overwrite daemon-provided when we have local SHA).
    if (currentSha) passport.sha = currentSha;
    if (this.plugin.coordinator && this.plugin.coordinator.deviceId) {
      passport.extracted_by = this.plugin.coordinator.deviceId;
    }
    passport.extracted_at = new Date().toISOString();
    // Persist incrementally
    const map = await this.loadAll();
    map.set(passport.path, passport);
    await this.saveAll(map);
    // Mirror passport metadata into manifest for fast staleness scans.
    try { await this._updateManifestEntry(passport); } catch (e) {
      console.warn('[zeus][passport] manifest mirror failed:', e.message);
    }
    this._lastBuiltAt = new Date().toISOString();
    return passport;
  }

  /**
   * Mirror passport_sha / passport_extracted_by / passport_extracted_at into
   * manifest.json files[<path>] for fast staleness scans (without parsing JSONL).
   */
  async _updateManifestEntry(passport) {
    if (!this.plugin.indexer || typeof this.plugin.indexer.loadManifest !== 'function') return;
    const m = await this.plugin.indexer.loadManifest();
    if (!m.files || typeof m.files !== 'object') m.files = {};
    const entry = m.files[passport.path] || {};
    entry.passport_sha = passport.sha || null;
    entry.passport_extracted_by = passport.extracted_by || null;
    entry.passport_extracted_at = passport.extracted_at || null;
    m.files[passport.path] = entry;
    await this.plugin.indexer.saveManifest(m);
  }

  /**
   * Batch extract all markdown notes in vault.
   * Calls daemon /v1/passport/batch-extract with progress callback.
   *
   * @param {(msg: string, pct?: number) => void} onProgress
   * @returns {Promise<{total: number, succeeded: number, failed: number}>}
   */
  async buildAll(onProgress = () => {}) {
    if (!this.plugin.httpClient) {
      throw new Error('PassportIndex.buildAll: httpClient indisponível');
    }
    const notes = await this._enumerateMarkdownNotes();
    onProgress(`enumerated ${notes.length} markdown notes`, 0);

    const BATCH = 100;
    const map = await this.loadAll();
    let succeeded = 0, failed = 0;

    for (let i = 0; i < notes.length; i += BATCH) {
      const chunk = notes.slice(i, i + BATCH);
      onProgress(`extracting passports ${i + 1}-${i + chunk.length}/${notes.length}…`,
                 Math.round(100 * i / notes.length));
      try {
        const resp = await this.plugin.httpClient.passportBatchExtract(chunk, []);
        const items = (resp && resp.passports) || (Array.isArray(resp) ? resp : []);
        for (const p of items) {
          if (p && p.path) {
            map.set(p.path, p);
            succeeded++;
          } else {
            failed++;
          }
        }
      } catch (e) {
        console.warn('[zeus][passport] batch fail:', e.message, 'chunk size:', chunk.length);
        failed += chunk.length;
      }
      // Persist after each chunk for resilience
      await this.saveAll(map);
    }

    this._lastBuiltAt = new Date().toISOString();
    onProgress(`done — ${succeeded} passports, ${failed} failed`, 100);

    // Regenerate Bases derivative
    try {
      if (this.plugin.basesGen) {
        await this.plugin.basesGen.regenerate();
      }
    } catch (e) {
      console.warn('[zeus][passport] bases regenerate failed:', e.message);
    }

    return { total: notes.length, succeeded, failed };
  }

  async _enumerateMarkdownNotes() {
    const exclusions = new Set(this.plugin.settings && this.plugin.settings.folderExclusions || []);
    // Use vault.getMarkdownFiles when available — already enumerates markdown vault-wide.
    if (this.plugin.app && this.plugin.app.vault && typeof this.plugin.app.vault.getMarkdownFiles === 'function') {
      const all = this.plugin.app.vault.getMarkdownFiles();
      const out = [];
      for (const f of all) {
        // skip if any segment is in exclusions
        const segments = f.path.split('/');
        let skip = false;
        for (const seg of segments) {
          if (exclusions.has(seg) || seg.startsWith('.')) { skip = true; break; }
        }
        if (!skip) out.push(f.path);
      }
      return out;
    }
    // Fallback to adapter walk.
    const skipNames = new Set(exclusions);
    const allFiles = await universal.adapterWalk(this._adapter, '', skipNames);
    return allFiles.filter(p => p.endsWith('.md'));
  }

  // ---- JSONL I/O ----

  /**
   * Load all passports as Map<path, passport>.
   * Cache invalidated when file mtime changes.
   */
  async loadAll() {
    const file = this.jsonlPath;
    if (!(await universal.adapterExists(this._adapter, file))) {
      this._cache = new Map();
      return this._cache;
    }
    let mtime = 0;
    const stat = await universal.adapterStat(this._adapter, file);
    if (stat && typeof stat.mtime === 'number') mtime = stat.mtime;
    if (this._cache && this._cacheLoadedAt >= mtime) {
      return this._cache;
    }
    const map = new Map();
    const raw = await universal.adapterRead(this._adapter, file);
    const lines = raw.split('\n');
    for (const ln of lines) {
      if (!ln.trim()) continue;
      try {
        const obj = JSON.parse(ln);
        if (obj && obj.path) map.set(obj.path, obj);
      } catch (e) {
        console.warn('[zeus][passport] skip bad line:', e.message);
      }
    }
    this._cache = map;
    this._cacheLoadedAt = Date.now();
    return map;
  }

  /**
   * Persist Map<path, passport> to JSONL atomically.
   */
  async saveAll(map) {
    await this._ensureDataDir();
    const lines = [];
    for (const passport of map.values()) {
      lines.push(JSON.stringify(passport));
    }
    await universal.adapterWriteAtomic(this._adapter, this.jsonlPath, lines.join('\n'));
    this._cache = map;
    this._cacheLoadedAt = Date.now();
  }

  // ---- Query (MCP-first surface) ----

  /**
   * Find passports semantically relevant to query.
   * Delegates to daemon /v1/passport/find (which combines embeddings cosine + concept match).
   *
   * @param {string} query
   * @param {object} options - { topN, minScore, conceptFilter, embeddingsPath, passportsPath }
   * @returns {Promise<Array<passport>>}
   */
  async findByQuery(query, options = {}) {
    if (!this.plugin.httpClient) {
      throw new Error('PassportIndex.findByQuery: httpClient indisponível');
    }
    const dataDir = this.dataPath;
    const opts = {
      topN: options.topN || 10,
      minScore: options.minScore || 0.3,
      conceptFilter: options.conceptFilter || null,
      embeddingsPath: options.embeddingsPath || universal.joinPath(dataDir, 'embeddings.jsonl'),
      passportsPath: options.passportsPath || this.jsonlPath,
    };
    const resp = await this.plugin.httpClient.passportFind(query, opts);
    return (resp && resp.results) || (Array.isArray(resp) ? resp : []);
  }

  /**
   * Lookup a single passport from in-memory cache (cheap).
   * Note: async because loadAll() is async.
   */
  async getPassport(notePath) {
    const map = await this.loadAll();
    return map.get(notePath) || null;
  }

  // ---- Stats ----

  /**
   * Return aggregate stats: total count, byDomain, byDifficulty, lastBuilt.
   */
  async stats() {
    const map = await this.loadAll();
    const byDomain = {};
    const byDifficulty = {};
    for (const p of map.values()) {
      for (const d of (p.domain || [])) {
        byDomain[d] = (byDomain[d] || 0) + 1;
      }
      const diff = String(p.difficulty != null ? p.difficulty : '?');
      byDifficulty[diff] = (byDifficulty[diff] || 0) + 1;
    }
    return {
      total: map.size,
      byDomain,
      byDifficulty,
      lastBuilt: this._lastBuiltAt,
    };
  }
}

module.exports = PassportIndex;
