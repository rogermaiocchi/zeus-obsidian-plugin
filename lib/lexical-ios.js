/*
 * lexical-ios.js — TF-IDF / BM25 persistido com stems pt-BR, JS puro.
 *
 * v1.11.0 — Feature I (closes "iOS lexical search sem daemon" gap):
 * lib/bm25.js já existente roda BM25 in-memory sobre as notas com embedding
 * carregado, mas NÃO persiste o índice. Em iOS, vault tem ~5k notas; recomputar
 * BM25 a cada query custa ~200-500ms. Esta lib materializa o posting list em
 * `data/lexical-ios.jsonl` (1 linha por nota + 1 header com IDF global) e
 * permite busca em ~10ms sem precisar carregar embeddings.
 *
 * Diferenças vs lib/bm25.js:
 *   - PERSISTÊNCIA: header line + 1 linha por nota com {tokens:[{token,tf}], dl}
 *   - STEMMING pt-BR leve via regex strip (-ção, -mente, -ável, -ado, -ido,
 *     -ar, -er, -ir, -idade, -mente) — captura paráfrase morfológica básica
 *     sem dicionário pesado (suficiente para vault PT-BR jurídico/técnico).
 *   - NORMALIZE NFD (decompose acentos) + lowercase para interop com bm25.js.
 *   - INCREMENTAL: upsert por path (re-tokeniza só a nota tocada).
 *
 * Schema persisted (`data/lexical-ios.jsonl`):
 *   Linha 0 (header):
 *     {"schema":"lexical-ios-v1", "N":<total_docs>, "avgdl":<float>,
 *      "idf":{token:idf_value, ...}, "last_built":"<ISO>"}
 *   Linha 1..N (docs):
 *     {"path":"<vault-rel>", "sha":"<sha256>",
 *      "tokens":[{"token":"...", "tf":<int>}, ...], "dl":<int>}
 *
 * Performance esperada (vault ~5k notas, ~500k tokens distintos):
 *   - build full: ~2-4s no Mac, ~8-12s em iPad (single thread)
 *   - search: ~10-20ms (linear sobre posting list, O(N) com early-exit possível)
 *   - incremental: ~5-20ms por nota (re-tokeniza + reescreve)
 *
 * Reusa tokenize() do bm25.js para garantir interop léxica.
 *
 * Referência: codex aprovação 2026-05-20 (Feature I para v1.11.0).
 */

'use strict';

const universal = require('./universal-fs');
const bm25Lib = require('./bm25');

const FILE_NAME = 'lexical-ios.jsonl';
const DATA_DIR_NAME = 'data';
const SCHEMA_VERSION = 'lexical-ios-v1';

// BM25 params (Robertson & Zaragoza 2009)
const K1 = 1.5;
const B = 0.75;

// Stems pt-BR — regex aplicado em ordem. Cada captura strip do sufixo se o
// token resultante tiver >= 3 chars (evita over-stem).
//
// IMPORTANTE: stemming é heurístico — preserva interop com bm25.js (mesmo
// tokenize), só adiciona uma camada de canonicalização. Para queries puramente
// lexicais (sigla, processo, ID), o stem é no-op.
const PT_SUFFIXES = [
  // Adjetivos/advérbios
  /(?:mente)$/,         // rapidamente → rapida
  /(?:idade|edade)$/,   // universidade → univers
  /(?:vel|vel)$/,       // amável → amá
  /(?:ável|ível|ável)$/,// readável → read
  // Substantivos
  /(?:ção|cao|ções|coes)$/,    // ação → a
  /(?:são|sao|sões|soes)$/,    // visão → vi
  // Verbos infinitivos
  /(?:ar|er|ir)$/,             // estudar → estud
  // Particípios
  /(?:ado|ido|ada|ida)$/,      // estudado → estud
  // Diminutivo (heurístico — pode over-stem; deixar last)
  /(?:inho|inha|inhos|inhas)$/,
  // Plural simples (mantido last)
  /(?:s)$/,
];

/**
 * Normaliza um token: NFD strip-acentos + lowercase + stem pt-BR leve.
 * @param {string} token
 * @returns {string|null} token canonicalizado, ou null se < 2 chars
 */
function normalizeAndStem(token) {
  if (!token || typeof token !== 'string') return null;
  // NFD: decompose acentos para char base + diacritic; strip diacriticos
  let t = token.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  if (t.length < 2) return null;
  // v1.11.1 codex MED #5: PRÉ-normalização pt-BR de plurais irregulares ANTES do
  // strip-suffix. Plural -ões/-ãos/-ães vira singular canonical:
  //   ações → acoes → acao (mesma raiz que 'ação')
  //   visões → visoes → visao
  //   pães → paes → pae (suficiente pra agrupar)
  if (t.length >= 4) {
    t = t.replace(/coes$/, 'cao');   // ações→ação raiz
    t = t.replace(/soes$/, 'sao');   // visões→visão
    t = t.replace(/oes$/, 'ao');     // razões→razão (gen)
    t = t.replace(/aes$/, 'ae');     // pães→pae (gen, perda mínima)
  }
  // Aplica stems em ordem; cada strip só vale se o resultante tiver >= 3 chars
  for (const re of PT_SUFFIXES) {
    const stripped = t.replace(re, '');
    if (stripped.length >= 3 && stripped.length < t.length) {
      t = stripped;
      break; // só 1 stem por token — evita cascata over-eager
    }
  }
  if (t.length < 2) return null;
  return t;
}

/**
 * Tokeniza + stem. Reusa bm25Lib.tokenize para a regex base, depois aplica
 * normalize+stem em cada token.
 * @param {string} text
 * @returns {string[]} tokens canonicalizados (com repetição para TF)
 */
function tokenizeAndStem(text) {
  const raw = bm25Lib.tokenize(text);
  const out = [];
  for (const t of raw) {
    const norm = normalizeAndStem(t);
    if (norm) out.push(norm);
  }
  return out;
}

/**
 * TF-array compacto: [{token, tf}] ordenado por tf desc (top-200 para limitar
 * tamanho do file por nota — corpus longo não precisa de cauda longa).
 * @param {string[]} tokens
 * @returns {Array<{token:string, tf:number}>}
 */
function buildTokenArray(tokens) {
  const counts = new Map();
  for (const t of tokens) counts.set(t, (counts.get(t) || 0) + 1);
  const arr = Array.from(counts.entries()).map(([token, tf]) => ({ token, tf }));
  arr.sort((a, b) => b.tf - a.tf);
  return arr.slice(0, 200);
}

class LexicalIosIndex {
  constructor(plugin) {
    this.plugin = plugin;
    // In-memory cache do index (parseado lazy no primeiro search/incremental)
    this._docs = new Map(); // path -> { sha, tokens:[{token,tf}], dl }
    this._header = null;    // { schema, N, avgdl, idf, last_built }
    // v1.11.1 codex MED #7: mutex pra serializar build/incremental concorrentes.
    // Sem isso, build() full pode escrever sobre incremental() mid-flight.
    this._writePromise = null;
    this._loaded = false;
  }

  get _adapter() {
    return this.plugin.app.vault.adapter;
  }

  get dataPath() {
    return universal.joinPath(this.plugin.manifest.dir, DATA_DIR_NAME);
  }

  get jsonlPath() {
    return universal.joinPath(this.dataPath, FILE_NAME);
  }

  async _ensureDir() {
    await universal.adapterMkdir(this._adapter, this.dataPath);
  }

  /**
   * Carrega o índice do disco para memória (lazy — só na primeira chamada).
   */
  async _load() {
    if (this._loaded) return;
    this._docs = new Map();
    this._header = null;
    if (!(await universal.adapterExists(this._adapter, this.jsonlPath))) {
      this._loaded = true;
      return;
    }
    try {
      const raw = await universal.adapterRead(this._adapter, this.jsonlPath);
      const lines = raw.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i].trim();
        if (!ln) continue;
        try {
          const obj = JSON.parse(ln);
          if (i === 0 && obj.schema === SCHEMA_VERSION) {
            this._header = obj;
          } else if (obj.path) {
            this._docs.set(obj.path, obj);
          }
        } catch (e) {
          console.warn('[zeus][lexical-ios] skip bad line', i, e.message);
        }
      }
    } catch (e) {
      console.warn('[zeus][lexical-ios] load failed:', e.message);
    }
    this._loaded = true;
  }

  /**
   * Persiste o índice in-memory para disco (header + 1 linha por doc).
   */
  async _persist() {
    // v1.11.1 codex MED #7: mutex serializa _persist (build/incremental concorrentes
    // não se sobrescrevem). Mesmo padrão MultiplexGraph._buildPromise v1.8.1.
    if (this._writePromise) await this._writePromise.catch(() => {});
    this._writePromise = (async () => {
      try {
        await this._ensureDir();
        const lines = [];
        if (this._header) lines.push(JSON.stringify(this._header));
        for (const doc of this._docs.values()) {
          lines.push(JSON.stringify(doc));
        }
        await universal.adapterWriteAtomic(this._adapter, this.jsonlPath, lines.join('\n'));
      } finally {
        this._writePromise = null;
      }
    })();
    return this._writePromise;
  }

  /**
   * Build full index: itera todas notas .md, tokeniza+stem, recomputa header
   * (N, avgdl, IDF global).
   *
   * @param {(msg:string, pct?:number) => void} onProgress
   * @returns {Promise<{N:number, vocab:number, elapsedMs:number}>}
   */
  async build(onProgress = () => {}) {
    const start = Date.now();
    await this._load();
    onProgress('enumerando notas…', 0);

    // Enumera notas via vault API quando disponível (Mac+iOS), fallback walk
    let notes = [];
    if (this.plugin.app && this.plugin.app.vault && this.plugin.app.vault.getMarkdownFiles) {
      notes = this.plugin.app.vault.getMarkdownFiles().map(f => f.path);
    } else {
      const all = await universal.adapterWalk(this._adapter, '');
      notes = all.filter(p => p.endsWith('.md'));
    }
    onProgress(`tokenizando ${notes.length} notas…`, 5);

    this._docs = new Map();
    let totalLen = 0;
    const df = new Map(); // token → doc frequency

    for (let i = 0; i < notes.length; i++) {
      const path = notes[i];
      if (i % 100 === 0) {
        onProgress(`tokenize ${i}/${notes.length}`, Math.round(5 + (90 * i) / notes.length));
      }
      let content = '';
      try {
        content = await universal.adapterRead(this._adapter, path);
      } catch (e) {
        console.warn('[zeus][lexical-ios] read fail', path, e.message);
        continue;
      }
      const tokens = tokenizeAndStem(content);
      if (tokens.length === 0) continue;
      const tokArr = buildTokenArray(tokens);
      const sha = await universal.sha256Hex(content);
      this._docs.set(path, { path, sha, tokens: tokArr, dl: tokens.length });
      totalLen += tokens.length;
      // df: cada token único nesta nota
      const seen = new Set();
      for (const t of tokens) seen.add(t);
      for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
    }

    const N = this._docs.size;
    const avgdl = N > 0 ? totalLen / N : 0;
    const idf = {};
    for (const [token, freq] of df.entries()) {
      // Okapi BM25 IDF (mesma fórmula que lib/bm25)
      idf[token] = Math.log(1 + (N - freq + 0.5) / (freq + 0.5));
    }
    this._header = {
      schema: SCHEMA_VERSION,
      N,
      avgdl,
      idf,
      last_built: new Date().toISOString(),
    };
    onProgress('persistindo…', 95);
    await this._persist();
    const elapsed = Date.now() - start;
    onProgress(`done — ${N} notas, ${Object.keys(idf).length} tokens únicos (${elapsed}ms)`, 100);
    return { N, vocab: Object.keys(idf).length, elapsedMs: elapsed };
  }

  /**
   * Search BM25 sobre o índice persistido.
   *
   * @param {string} query
   * @param {number} [topN=30]
   * @returns {Promise<Array<{path:string, score:number, matched_tokens:string[]}>>}
   */
  async search(query, topN = 30) {
    await this._load();
    if (!this._header || this._docs.size === 0) return [];
    if (!query || typeof query !== 'string' || !query.trim()) return [];
    const qTokens = tokenizeAndStem(query);
    if (qTokens.length === 0) return [];
    const qSet = new Set(qTokens);

    const avgdl = this._header.avgdl || 0;
    const idfMap = this._header.idf || {};
    const results = [];
    for (const doc of this._docs.values()) {
      // TF lookup: linear scan no array (top-200 garante <O(N) na prática)
      const tfMap = new Map();
      for (const { token, tf } of (doc.tokens || [])) {
        if (qSet.has(token)) tfMap.set(token, tf);
      }
      if (tfMap.size === 0) continue;
      let score = 0;
      const matched = [];
      for (const qt of qSet) {
        const freq = tfMap.get(qt) || 0;
        if (freq === 0) continue;
        const idf = idfMap[qt] || 0;
        if (idf === 0) continue;
        const dl = doc.dl || 0;
        const denom = avgdl > 0
          ? (freq + K1 * (1 - B + (B * dl) / avgdl))
          : freq;
        score += (idf * (freq * (K1 + 1))) / denom;
        matched.push(qt);
      }
      if (score > 0) {
        results.push({ path: doc.path, score, matched_tokens: matched });
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topN);
  }

  /**
   * Atualização incremental: re-tokeniza UMA nota, atualiza posting list e
   * recalcula df (delta) + persiste.
   *
   * NOTA: recalcular IDF global a cada incremental é caro (O(vocab)). Em vez,
   * marcamos o header como "stale-incremental" e o consumer pode chamar
   * recomputeIdf() em background. Para queries-críticas, prefere rebuild.
   *
   * @param {string} path
   * @param {string|null} sha (opcional — se ausente, recomputa)
   * @returns {Promise<{updated:boolean, reason?:string}>}
   */
  async incremental(path, sha = null) {
    await this._load();
    if (!path || !path.endsWith('.md')) return { updated: false, reason: 'not-md' };
    // v1.15 — codex round 5: coage path absoluto (caller Mac) para vault-relative.
    // O adapter já só aceita relativo (absoluto falharia o read), mas normalizar
    // aqui mantém o índice 100% vault-relative e simétrico com passport-index.
    const vroot = this.plugin && this.plugin.vaultRoot;
    if (vroot && path.startsWith(vroot)) {
      path = path.slice(vroot.length).replace(/^\/+/, '');
    }
    let content;
    try {
      content = await universal.adapterRead(this._adapter, path);
    } catch (e) {
      // Nota deletada: remove do índice
      if (this._docs.has(path)) {
        this._docs.delete(path);
        await this._persist();
        return { updated: true, reason: 'deleted' };
      }
      return { updated: false, reason: e.message };
    }
    const currentSha = sha || await universal.sha256Hex(content);
    const existing = this._docs.get(path);
    if (existing && existing.sha === currentSha) {
      return { updated: false, reason: 'sha unchanged' };
    }
    const tokens = tokenizeAndStem(content);
    const tokArr = buildTokenArray(tokens);
    this._docs.set(path, { path, sha: currentSha, tokens: tokArr, dl: tokens.length });

    // v1.11.1 codex HIGH #3 + MED #6: se header é null, recompute full (caller
    // pode ter chamado incremental SEM ter rodado build() prévio — sem header
    // search() retorna []). Também usa _recomputeHeader pra IDF consistente.
    this._recomputeHeader();
    await this._persist();
    return { updated: true };
  }

  // v1.11.1 codex MED #6: _recomputeHeader varre _docs e refaz idf/avgdl/N
  // do zero. Garante consistência sem necessitar build() periódico. O(D × T_avg)
  // mas em vault típico (~1k notas, ~200 tokens cada) é <50ms.
  _recomputeHeader() {
    const N = this._docs.size;
    if (N === 0) {
      this._header = { schema: 'lexical-ios-v1', N: 0, avgdl: 0, idf: {}, last_built: new Date().toISOString() };
      return;
    }
    let totalLen = 0;
    const df = new Map();
    for (const doc of this._docs.values()) {
      totalLen += doc.dl || 0;
      const seen = new Set();
      // codex HIGH #2: doc.tokens é array de OBJETOS {token, tf} — não array-pair.
      // Antes faziamos [token] destructure que retornava undefined, quebrando IDF.
      for (const entry of (doc.tokens || [])) {
        const token = entry && entry.token;
        if (!token || seen.has(token)) continue;
        seen.add(token);
        df.set(token, (df.get(token) || 0) + 1);
      }
    }
    const idf = {};
    for (const [t, dfCount] of df) {
      idf[t] = Math.log(1 + (N - dfCount + 0.5) / (dfCount + 0.5));
    }
    this._header = {
      schema: 'lexical-ios-v1',
      N,
      avgdl: totalLen / N,
      idf,
      last_built: new Date().toISOString(),
    };
  }

  /**
   * Stats agregados: N, avgdl, vocab, last_built.
   * @returns {Promise<{N:number, avgdl:number, vocab_size:number, last_built:string|null}>}
   */
  async stats() {
    await this._load();
    return {
      N: this._docs.size,
      avgdl: this._header ? this._header.avgdl : 0,
      vocab_size: this._header && this._header.idf ? Object.keys(this._header.idf).length : 0,
      last_built: this._header ? this._header.last_built : null,
    };
  }
}

module.exports = LexicalIosIndex;
module.exports._tokenizeAndStem = tokenizeAndStem;
module.exports._normalizeAndStem = normalizeAndStem;
