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
 * Referência: ADR-018, brainstorm session 2026-05-14 (PIA architecture).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PASSPORTS_FILE = 'passports.jsonl';
const DATA_DIR_NAME = 'data';

class PassportIndex {
  constructor(plugin) {
    this.plugin = plugin;
    this._cache = null;          // Map<path, passport>
    this._cacheLoadedAt = 0;
    this._lastBuiltAt = null;
  }

  // ---- Path helpers ----

  get dataPath() {
    return path.join(this.plugin.vaultRoot, this.plugin.manifest.dir, DATA_DIR_NAME);
  }

  get jsonlPath() {
    return path.join(this.dataPath, PASSPORTS_FILE);
  }

  _ensureDataDir() {
    if (!fs.existsSync(this.dataPath)) fs.mkdirSync(this.dataPath, { recursive: true });
  }

  // ---- Build / extract operations ----

  /**
   * Extract passport for a single note.
   * Calls daemon /v1/passport/extract.
   * Returns the passport object (also persisted to JSONL).
   */
  async buildOne(filePath, domainOptions = []) {
    if (!this.plugin.httpClient) {
      throw new Error('PassportIndex.buildOne: httpClient indisponível');
    }
    const passport = await this.plugin.httpClient.passportExtract(filePath, domainOptions);
    if (!passport || !passport.path) {
      throw new Error(`PassportIndex.buildOne: resposta inválida para ${filePath}`);
    }
    // Persist incrementally
    const map = this.loadAll();
    map.set(passport.path, passport);
    this.saveAll(map);
    this._lastBuiltAt = new Date().toISOString();
    return passport;
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
    const notes = this._enumerateMarkdownNotes();
    onProgress(`enumerated ${notes.length} markdown notes`, 0);

    const BATCH = 100;
    const map = this.loadAll();
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
      this.saveAll(map);
    }

    this._lastBuiltAt = new Date().toISOString();
    onProgress(`done — ${succeeded} passports, ${failed} failed`, 100);

    // Regenerate Bases derivative
    try {
      if (this.plugin.basesGen) {
        this.plugin.basesGen.regenerate();
      }
    } catch (e) {
      console.warn('[zeus][passport] bases regenerate failed:', e.message);
    }

    return { total: notes.length, succeeded, failed };
  }

  _enumerateMarkdownNotes() {
    const out = [];
    const exclusions = new Set(this.plugin.settings && this.plugin.settings.folderExclusions || []);
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of entries) {
        if (ent.name.startsWith('.')) continue;
        if (exclusions.has(ent.name)) continue;
        const abs = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          walk(abs);
        } else if (ent.isFile() && ent.name.endsWith('.md')) {
          out.push(path.relative(this.plugin.vaultRoot, abs));
        }
      }
    };
    walk(this.plugin.vaultRoot);
    return out;
  }

  // ---- JSONL I/O ----

  /**
   * Load all passports as Map<path, passport>.
   * Cache invalidated when file mtime changes.
   */
  loadAll() {
    const file = this.jsonlPath;
    if (!fs.existsSync(file)) {
      this._cache = new Map();
      return this._cache;
    }
    let mtime;
    try { mtime = fs.statSync(file).mtimeMs; } catch { mtime = 0; }
    if (this._cache && this._cacheLoadedAt >= mtime) {
      return this._cache;
    }
    const map = new Map();
    const lines = fs.readFileSync(file, 'utf8').split('\n');
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
  saveAll(map) {
    this._ensureDataDir();
    const lines = [];
    for (const passport of map.values()) {
      lines.push(JSON.stringify(passport));
    }
    const tmp = this.jsonlPath + '.tmp';
    fs.writeFileSync(tmp, lines.join('\n'));
    fs.renameSync(tmp, this.jsonlPath);
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
      embeddingsPath: options.embeddingsPath || path.join(dataDir, 'embeddings.jsonl'),
      passportsPath: options.passportsPath || this.jsonlPath,
    };
    const resp = await this.plugin.httpClient.passportFind(query, opts);
    return (resp && resp.results) || (Array.isArray(resp) ? resp : []);
  }

  /**
   * Lookup a single passport from in-memory cache (cheap).
   */
  getPassport(notePath) {
    const map = this.loadAll();
    return map.get(notePath) || null;
  }

  // ---- Stats ----

  /**
   * Return aggregate stats: total count, byDomain, byDifficulty, lastBuilt.
   */
  stats() {
    const map = this.loadAll();
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
