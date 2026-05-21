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
const { extractPassportLocal } = require('./passport-ios');
const bm25 = require('./bm25');

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
    // v1.11 — Feature E: iOS-local fallback quando httpClient indisponível ou
    // daemon fora do ar. Mantém o MESMO schema canônico de passports.jsonl
    // (só model_versions.passport difere para auditoria).
    //
    // Decisão daemon vs local: prefere daemon (qualidade FM); cai para local
    // se httpClient ausente OU isAvailable() falhar.
    let daemonReachable = false;
    if (this.plugin.httpClient && typeof this.plugin.httpClient.isAvailable === 'function') {
      try {
        daemonReachable = await this.plugin.httpClient.isAvailable(1500);
      } catch { daemonReachable = false; }
    }
    if (!daemonReachable) {
      return await this._buildOneLocal(filePath);
    }
    // Compute current SHA before daemon call so we can attach it to the passport
    // even if the daemon doesn't return one.
    let currentSha = null;
    try {
      // SHA precompute usa o vault-relative path; quando filePath é absoluto
      // (Mac AutoIndexer), tenta extrair vault-relative removendo o vaultRoot.
      const relForRead = this._vaultRelative(filePath);
      if (relForRead && await universal.adapterExists(this._adapter, relForRead)) {
        const content = await universal.adapterRead(this._adapter, relForRead);
        currentSha = await universal.sha256Hex(content);
      }
    } catch (e) {
      console.warn('[zeus][passport] sha precompute failed for', filePath, e.message);
    }
    let passport;
    try {
      passport = await this.plugin.httpClient.passportExtract(filePath, domainOptions);
    } catch (e) {
      // Daemon respondeu isAvailable mas /v1/passport/extract falhou — caímos
      // para local mesmo assim, mantendo a promessa de "indexação never blocks".
      console.warn('[zeus][passport] daemon extract failed, fallback to ios-local:', e.message);
      return await this._buildOneLocal(filePath);
    }
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
   * v1.11 Feature E — Coage o filePath para vault-relative.
   * AutoIndexer passa abs path no Mac (`/Users/.../vault/Note.md`); vault.adapter
   * só aceita vault-relative. Se filePath for absoluto e começar com vaultRoot,
   * tira o prefixo. Senão retorna como veio (assume relativo).
   */
  _vaultRelative(filePath) {
    if (!filePath || typeof filePath !== 'string') return filePath;
    const root = this.plugin && this.plugin.vaultRoot;
    if (root && filePath.startsWith(root)) {
      const stripped = filePath.slice(root.length).replace(/^\/+/, '');
      return stripped;
    }
    return filePath;
  }

  /**
   * v1.11 Feature E — Build passport puramente local (sem daemon) via
   * extractPassportLocal. Usado:
   *   - iOS quando httpClient indisponível
   *   - Mac quando daemon offline e usuário não quer bloquear
   *
   * Persiste no MESMO passports.jsonl que o caminho daemon — só
   * model_versions.passport difere ('zeus-ios-1.11.0').
   */
  async _buildOneLocal(filePath) {
    const relPath = this._vaultRelative(filePath);
    if (!relPath) {
      throw new Error('PassportIndex._buildOneLocal: filePath inválido');
    }
    if (!(await universal.adapterExists(this._adapter, relPath))) {
      throw new Error(`PassportIndex._buildOneLocal: arquivo não existe: ${relPath}`);
    }
    const content = await universal.adapterRead(this._adapter, relPath);
    const metadataCache = this.plugin.app && this.plugin.app.metadataCache;
    const passport = await extractPassportLocal(relPath, content, metadataCache);

    // SHA + identity stamps (mesmo padrão do caminho daemon)
    try {
      passport.sha = await universal.sha256Hex(content);
    } catch (e) {
      console.warn('[zeus][passport] local sha failed:', e.message);
    }
    if (this.plugin.coordinator && this.plugin.coordinator.deviceId) {
      passport.extracted_by = this.plugin.coordinator.deviceId;
    }
    // extracted_at já é setado pelo extractPassportLocal; respeita.
    passport.path = relPath;

    // Persist incremental (mesmo passports.jsonl que o daemon usa)
    const map = await this.loadAll();
    map.set(passport.path, passport);
    await this.saveAll(map);
    try { await this._updateManifestEntry(passport); } catch (e) {
      console.warn('[zeus][passport] manifest mirror failed (local):', e.message);
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
    // v1.11 Feature E — fallback iOS-local quando httpClient ausente OU daemon
    // fora do ar. Reusa lib/bm25 + concept-overlap sobre passports.jsonl local.
    let daemonReachable = false;
    if (this.plugin.httpClient && typeof this.plugin.httpClient.isAvailable === 'function') {
      try {
        daemonReachable = await this.plugin.httpClient.isAvailable(1500);
      } catch { daemonReachable = false; }
    }
    if (!daemonReachable) {
      return await this.findByQueryLocal(query, options);
    }
    const dataDir = this.dataPath;
    const opts = {
      topN: options.topN || 10,
      minScore: options.minScore || 0.3,
      conceptFilter: options.conceptFilter || null,
      embeddingsPath: options.embeddingsPath || universal.joinPath(dataDir, 'embeddings.jsonl'),
      passportsPath: options.passportsPath || this.jsonlPath,
    };
    try {
      const resp = await this.plugin.httpClient.passportFind(query, opts);
      return (resp && resp.results) || (Array.isArray(resp) ? resp : []);
    } catch (e) {
      console.warn('[zeus][passport] daemon find failed, fallback to local:', e.message);
      return await this.findByQueryLocal(query, options);
    }
  }

  /**
   * v1.11 Feature E — busca local sobre passports.jsonl quando daemon não está
   * disponível (iOS sandbox).
   *
   * Score = concept_overlap(query_tokens, p.concepts) +
   *         bm25Score(query_tokens, p.one_line_summary || basename(p.path))
   *
   * Reusa lib/bm25 — tokenize idêntica, garante interop léxica com o retriever
   * principal. concept_overlap conta tokens da query que aparecem como substring
   * case-insensitive em algum concept do passport (Jaccard-like; pesa overlap
   * sem inflar por concept-redundance).
   *
   * @param {string} query
   * @param {object} options - { topN, minScore, conceptFilter }
   * @returns {Promise<Array<passport>>}
   */
  async findByQueryLocal(query, options = {}) {
    if (!query || typeof query !== 'string' || !query.trim()) return [];
    const topN = options.topN || 10;
    const minScore = options.minScore != null ? options.minScore : 0;
    const conceptFilter = options.conceptFilter
      ? new Set((Array.isArray(options.conceptFilter) ? options.conceptFilter : [options.conceptFilter])
          .map(s => String(s).toLowerCase()))
      : null;

    const map = await this.loadAll();
    if (map.size === 0) return [];

    const queryTokens = bm25.tokenize(query);
    if (queryTokens.length === 0) return [];
    const queryTokenSet = new Set(queryTokens);

    // Constrói corpus para BM25 sobre one_line_summary + cornell_cue + basename
    const passports = Array.from(map.values());
    const corpus = passports.map(p => {
      const summary = p.one_line_summary || p.summary || '';
      const basename = (p.path || '').split('/').pop().replace(/\.md$/, '');
      const cornellText = Array.isArray(p.cornell_cue) ? p.cornell_cue.join(' ') : '';
      return bm25.tokenize(summary + ' ' + cornellText + ' ' + basename);
    });
    const bmScores = bm25.bm25Scores(corpus, queryTokens);

    // Concept overlap por passport
    const scored = [];
    for (let i = 0; i < passports.length; i++) {
      const p = passports[i];
      // ConceptFilter: rejeita passports que não tenham AO MENOS um concept casando
      if (conceptFilter) {
        const concepts = (p.concepts || []).map(c => String(c).toLowerCase());
        let hasMatch = false;
        for (const c of concepts) {
          if (conceptFilter.has(c)) { hasMatch = true; break; }
        }
        if (!hasMatch) continue;
      }
      // Concept overlap: tokens da query que aparecem como substring em concept
      let overlap = 0;
      const concepts = (p.concepts || []);
      for (const c of concepts) {
        const cLower = String(c).toLowerCase();
        for (const qt of queryTokenSet) {
          if (cLower === qt || cLower.includes(qt) || qt.includes(cLower)) {
            overlap++;
            break; // 1 match por concept evita over-counting
          }
        }
      }
      // Score combinado: concept overlap (peso 1.0) + BM25 score (peso 0.5
      // — BM25 já é normalizado por IDF/length, mas overlap é sinal mais
      // direto sobre passport canônico).
      const score = overlap + 0.5 * bmScores[i];
      if (score < minScore) continue;
      scored.push({ passport: p, score, overlap, bm25: bmScores[i] });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topN).map(x => ({
      ...x.passport,
      _score: x.score,
      _overlap: x.overlap,
      _bm25: x.bm25,
      _source: 'ios-local',
    }));
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
