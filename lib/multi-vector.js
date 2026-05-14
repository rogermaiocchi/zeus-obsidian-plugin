/*
 * MultiVectorEmbedder — effective 1536-dim coverage via 3×512-dim NLContextualEmbedding
 *
 * For each document, produces THREE separate Apple-native 512-dim vectors:
 *   - title_vec    : embedding of the title alone
 *   - body_vec     : embedding of the (truncated) body
 *   - summary_vec  : embedding of an LLM-generated TL;DR (afm summarize)
 *
 * Ranking uses MAX-pool cosine: score(q, doc) = max(cos(q, title_vec), cos(q, body_vec), cos(q, summary_vec))
 * This gives effective 1536-dim "soft" coverage — different aspects of the doc compete
 * for the query, and the strongest match wins.
 *
 * No CoreML, no 768-dim external models. 100% Apple-native via afm CLI.
 *
 * Batch optimization (critical for throughput):
 *   For N docs, embedDocsBatch performs:
 *     - 1 batched `afm embed` call for all N titles
 *     - 1 batched `afm embed` call for all N bodies
 *     - N parallel-limited (concurrency=4) `afm summarize` calls (cannot batch)
 *     - 1 batched `afm embed` call for all N summaries
 *   → 3 embed spawns + N summarize spawns, NOT 3N embed spawns.
 *
 * Persistence: data/multi-vectors.jsonl (sibling of embeddings.jsonl, JSONL one-per-doc).
 *
 * Plain ES2020 CommonJS — no new deps.
 */

'use strict';

// v0.11 — guard Node-only requires for iOS sandbox safety.
// multi-vector depends on spawning `afm` CLI; only Mac. iOS plugin still loads
// the module; methods throw "not available" if invoked.
const universal = require('./universal-fs');
const spawn = universal.nodeChildProcess ? universal.nodeChildProcess.spawn : null;
const path = universal.nodePath;
const fs = universal.nodeFs;
const crypto = universal.nodeCrypto;

const MULTI_VECTORS_FILE = 'multi-vectors.jsonl';
const SUMMARIZE_CONCURRENCY = 4;
const BODY_MAX_CHARS = 4000;
const SUMMARY_FALLBACK_CHARS = 500;
const EMBED_TIMEOUT_MS = 300000;
const SUMMARIZE_TIMEOUT_MS = 60000;

// =========================================================================
// Local helpers (self-contained — do not import from main.js)
// =========================================================================

function cosine(a, b) {
  if (!a || !b) return 0;
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function sha256(text) {
  if (crypto && typeof crypto.createHash === 'function') {
    return crypto.createHash('sha256').update(text).digest('hex');
  }
  // Sync fallback for iOS — uses a 32-bit rolling hash. Not crypto-strong; only
  // used as a content-change marker for multi-vector cache invalidation.
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}

function execAfm(binPath, args, stdinText, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!spawn) {
      reject(new Error('multi-vector.execAfm: child_process unavailable (iOS sandbox)'));
      return;
    }
    const child = spawn(binPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('afm timeout after ' + timeoutMs + 'ms'));
    }, timeoutMs);
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error('afm exit ' + code + ': ' + stderr.slice(0, 400)));
    });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    if (stdinText != null) {
      child.stdin.write(stdinText);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

// Parse JSON output that may have leading prose lines before the JSON object
function parseEmbedOutput(out) {
  const trimmed = out.trim();
  // Try direct parse first
  try {
    const obj = JSON.parse(trimmed);
    return obj.vectors || [];
  } catch (e) {
    // Fall through to extract JSON object
  }
  const start = trimmed.indexOf('{');
  if (start < 0) throw new Error('no JSON object in afm output');
  const obj = JSON.parse(trimmed.slice(start));
  return obj.vectors || [];
}

// Run an async fn over items with bounded concurrency
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i], i);
      } catch (e) {
        results[i] = { __error: e.message || String(e) };
      }
    }
  }
  const workers = [];
  for (let w = 0; w < Math.min(limit, items.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// =========================================================================
// MultiVectorEmbedder
// =========================================================================

class MultiVectorEmbedder {
  constructor(afmBinPath, dataPath) {
    this.afmBinPath = afmBinPath;
    this.dataPath = dataPath;
    // path may be null on iOS; fall back to forward-slash join.
    this.jsonlPath = path
      ? path.join(dataPath, MULTI_VECTORS_FILE)
      : `${dataPath}/${MULTI_VECTORS_FILE}`.replace(/\/+/g, '/');
  }

  // -----------------------------------------------------------------------
  // Single-doc convenience (NOT batch-optimized — prefer embedDocsBatch)
  // -----------------------------------------------------------------------
  async embedDoc({ path: docPath, title, body }) {
    const map = await this.embedDocsBatch([{ path: docPath, title, body }]);
    const v = map.get(docPath) || {};
    const sha = sha256((title || '') + '\n' + (body || ''));
    return {
      path: docPath,
      sha,
      title_vec: v.title_vec || null,
      body_vec: v.body_vec || null,
      summary_vec: v.summary_vec || null,
    };
  }

  // -----------------------------------------------------------------------
  // Batch: 3 embed spawns total + N concurrent-limited summarize spawns
  // -----------------------------------------------------------------------
  async embedDocsBatch(docs) {
    const result = new Map();
    if (!docs || docs.length === 0) return result;

    const titles = docs.map(d => (d.title || '').trim() || (d.path || 'untitled'));
    const bodies = docs.map(d => (d.body || '').slice(0, BODY_MAX_CHARS));

    // 1. Generate summaries in parallel (concurrency-limited).
    //    afm summarize is single-input, so we cannot batch it.
    const summaries = await mapWithConcurrency(
      bodies,
      SUMMARIZE_CONCURRENCY,
      async (body) => {
        const text = (body || '').trim();
        if (!text) return '';
        try {
          const out = await execAfm(
            this.afmBinPath,
            ['summarize'],
            text,
            SUMMARIZE_TIMEOUT_MS
          );
          const tldr = (out || '').trim();
          if (tldr) return tldr;
          // Empty output → fallback
          return body.slice(0, SUMMARY_FALLBACK_CHARS);
        } catch (e) {
          // Summarize failed → fallback to body prefix so we still have something to embed
          return body.slice(0, SUMMARY_FALLBACK_CHARS);
        }
      }
    );

    const summaryTexts = summaries.map((s, i) => {
      if (s && typeof s === 'object' && s.__error) return bodies[i].slice(0, SUMMARY_FALLBACK_CHARS);
      return String(s || '');
    });

    // 2-4. Three batched embed calls. If any batch fails entirely, fill with nulls
    //      so scoreDocVsQuery can degrade gracefully.
    let titleVecs = null, bodyVecs = null, summaryVecs = null;

    try {
      titleVecs = await this._embedBatch(titles);
    } catch (e) {
      titleVecs = new Array(titles.length).fill(null);
    }
    try {
      bodyVecs = await this._embedBatch(bodies);
    } catch (e) {
      bodyVecs = new Array(bodies.length).fill(null);
    }
    try {
      summaryVecs = await this._embedBatch(summaryTexts);
    } catch (e) {
      summaryVecs = new Array(summaryTexts.length).fill(null);
    }

    for (let i = 0; i < docs.length; i++) {
      result.set(docs[i].path, {
        title_vec: titleVecs[i] || null,
        body_vec: bodyVecs[i] || null,
        summary_vec: summaryVecs[i] || null,
      });
    }
    return result;
  }

  // Internal: one batched afm embed call → array of vectors aligned with input texts.
  async _embedBatch(texts) {
    if (!texts || texts.length === 0) return [];
    // afm embed accepts JSON array via stdin → vectors[] in output
    const stdin = JSON.stringify(texts);
    const out = await execAfm(
      this.afmBinPath,
      ['embed', '--backend', 'apple'],
      stdin,
      EMBED_TIMEOUT_MS
    );
    const vectors = parseEmbedOutput(out);
    // Pad/truncate to match input length defensively
    const padded = new Array(texts.length).fill(null);
    for (let i = 0; i < Math.min(vectors.length, texts.length); i++) {
      padded[i] = vectors[i] || null;
    }
    return padded;
  }

  // -----------------------------------------------------------------------
  // Query embedding — single text → single 512-dim vector
  // -----------------------------------------------------------------------
  async embedQuery(query) {
    const q = (query || '').trim();
    if (!q) return null;
    const vecs = await this._embedBatch([q]);
    return vecs[0] || null;
  }

  // -----------------------------------------------------------------------
  // Scoring — MAX-pool cosine over the 3 doc vectors
  // -----------------------------------------------------------------------
  scoreDocVsQuery(qVec, docVecs) {
    if (!qVec || !docVecs) return { score: 0, source: null };
    const candidates = [
      { source: 'title', vec: docVecs.title_vec },
      { source: 'body', vec: docVecs.body_vec },
      { source: 'summary', vec: docVecs.summary_vec },
    ];
    let best = { score: -Infinity, source: null };
    for (const c of candidates) {
      if (!c.vec) continue;
      const s = cosine(qVec, c.vec);
      if (s > best.score) best = { score: s, source: c.source };
    }
    if (best.source == null) return { score: 0, source: null };
    return best;
  }

  // -----------------------------------------------------------------------
  // Persistence — JSONL, one doc per line
  // -----------------------------------------------------------------------
  saveAll(map) {
    if (!map) return;
    if (!fs) {
      throw new Error('multi-vector.saveAll: fs unavailable (iOS sandbox). Run reindex on Mac.');
    }
    fs.mkdirSync(this.dataPath, { recursive: true });
    const tmpPath = this.jsonlPath + '.tmp';
    const lines = [];
    for (const [docPath, entry] of map.entries()) {
      lines.push(JSON.stringify({
        path: docPath,
        sha: entry.sha || null,
        mtime: entry.mtime || null,
        title: entry.title || null,
        title_vec: entry.title_vec || null,
        body_vec: entry.body_vec || null,
        summary_vec: entry.summary_vec || null,
      }));
    }
    fs.writeFileSync(tmpPath, lines.join('\n') + (lines.length ? '\n' : ''), 'utf8');
    fs.renameSync(tmpPath, this.jsonlPath);
  }

  loadAll() {
    const map = new Map();
    if (!fs) return map; // iOS — multi-vector cache not loadable; safe empty.
    if (!fs.existsSync(this.jsonlPath)) return map;
    const raw = fs.readFileSync(this.jsonlPath, 'utf8');
    const lines = raw.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed);
        if (!obj.path) continue;
        map.set(obj.path, {
          path: obj.path,
          sha: obj.sha || null,
          mtime: obj.mtime || null,
          title: obj.title || null,
          title_vec: obj.title_vec || null,
          body_vec: obj.body_vec || null,
          summary_vec: obj.summary_vec || null,
        });
      } catch (e) {
        // Skip malformed lines
      }
    }
    return map;
  }
}

module.exports = MultiVectorEmbedder;
