/*
 * Zeus — HierarchicalProcessor
 *
 * Pattern lineage: NexusSum hierarchical merging (Park et al., ACL 2025,
 * arXiv:2505.24575). NexusSum demonstrates +30% BERTScore vs flat summarization
 * on long-document benchmarks by recursively reducing chunk summaries before
 * final synthesis. We adapt that recipe to overcome the FoundationModels
 * 4096-token context window (~10KB chars, ~2KB after system prompt + tool
 * descriptions + tool responses) when running `afm enrich` on large notes.
 *
 * Strategy:
 *   chunk(text)              → string[] (paragraph-aware, with overlap)
 *   summarizeChunks(chunks)  → string[]  (one short TL;DR per chunk)
 *   recursiveReduce(sums)    → string    (until ≤ maxChunkChars or maxIter)
 *   enrichSummary(summary)   → JSON object from `afm enrich` on a tiny temp note
 *
 * Plain ES2020 CommonJS, no npm deps. Mirrors the spawn/exec shape of
 * execMetafm() in main.js — kept local so this file is self-contained.
 */

'use strict';

// v0.11 — guard Node-only requires so module load doesn't crash on iOS.
// hierarchical processor depends on `afm` CLI via child_process — only Mac.
// On iOS, public methods throw "not available" if called; caller's HTTP-daemon
// path covers the same operations.
const universal = require('./universal-fs');
const spawn = universal.nodeChildProcess ? universal.nodeChildProcess.spawn : null;
const path = universal.nodePath;
const fs = universal.nodeFs;
const crypto = universal.nodeCrypto;
const nodeOs = universal.nodeOs;

const DEFAULT_TIMEOUT_MS = 90000;
const RECURSIVE_REDUCE_MAX_ITER = 3;
const SUMMARY_TARGET_CHARS = 300;     // per-chunk summary cap
const FINAL_SUMMARY_TARGET_CHARS = 2000; // ~500 tokens

// ---------------------------------------------------------------------------
// Local helper — sibling of execMetafm() in main.js. Kept local to avoid
// circular imports; signature intentionally identical for cognitive economy.
// ---------------------------------------------------------------------------
function execAfm(binPath, args, stdinText, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    if (!spawn) {
      reject(new Error('hierarchical.execAfm: child_process unavailable (iOS sandbox)'));
      return;
    }
    let child;
    try {
      child = spawn(binPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject(new Error('afm spawn failed: ' + e.message));
      return;
    }
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      reject(new Error('afm timeout (' + timeoutMs + 'ms)'));
    }, timeoutMs);
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error('afm exit ' + code + ': ' + stderr.slice(0, 400)));
    });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    if (stdinText) {
      try { child.stdin.write(stdinText); child.stdin.end(); }
      catch (e) { /* stdin closed early — ignore */ }
    } else {
      try { child.stdin.end(); } catch {}
    }
  });
}

function sha8(s) {
  if (crypto && typeof crypto.createHash === 'function') {
    return crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
  }
  // Fallback: cheap rolling-hash short hex; not crypto-strong but only used as a temp filename tag.
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 8);
}

// ---------------------------------------------------------------------------
// HierarchicalProcessor
// ---------------------------------------------------------------------------
class HierarchicalProcessor {
  constructor(afmBinPath, maxChunkChars = 8000) {
    if (!afmBinPath) throw new Error('HierarchicalProcessor: afmBinPath required');
    this.afmBin = afmBinPath;
    this.maxChunkChars = maxChunkChars;
    // Discovered batch signature is memoized — null = unknown, false = unsupported,
    // object = { mode: 'stdin-json' | 'dir' } once we know what works.
    this._batchMode = null;
  }

  // -------------------------------------------------------------------------
  // chunkText — paragraph-aware splitter with overlap. Three-tier fallback:
  //   1. Split on double-newline (paragraph boundaries).
  //   2. If a paragraph itself exceeds maxChars, split on sentence boundaries
  //      (". " or "? " or "! ").
  //   3. If a sentence still exceeds, hard-cut at maxChars.
  // Overlap: append last `overlapChars` of chunk N to start of chunk N+1.
  // -------------------------------------------------------------------------
  chunkText(text, maxChars, overlapChars = 200) {
    if (!text || typeof text !== 'string') return [];
    maxChars = maxChars || this.maxChunkChars;
    if (text.length <= maxChars) return [text];
    if (overlapChars >= maxChars) overlapChars = Math.floor(maxChars / 4);

    // Tokenize into atoms (paragraphs → sentences → hard cuts) that each
    // individually fit in maxChars. Then pack atoms into chunks.
    const atoms = [];
    const paragraphs = text.split(/\n\s*\n/);
    for (const para of paragraphs) {
      if (!para.trim()) continue;
      if (para.length <= maxChars) {
        atoms.push(para);
        continue;
      }
      // Sentence-level split — keep delimiters reasonably
      const sentences = para.split(/(?<=[.!?])\s+/);
      for (const sent of sentences) {
        if (sent.length <= maxChars) {
          atoms.push(sent);
        } else {
          // Hard char-cut fallback
          for (let i = 0; i < sent.length; i += maxChars) {
            atoms.push(sent.slice(i, i + maxChars));
          }
        }
      }
    }

    // Pack atoms greedily into chunks
    const chunks = [];
    let current = '';
    for (const atom of atoms) {
      const sep = current ? '\n\n' : '';
      if (current.length + sep.length + atom.length <= maxChars) {
        current += sep + atom;
      } else {
        if (current) chunks.push(current);
        current = atom;
      }
    }
    if (current) chunks.push(current);

    // Apply overlap: prepend tail of chunk[i-1] to chunk[i]
    if (overlapChars > 0 && chunks.length > 1) {
      const withOverlap = [chunks[0]];
      for (let i = 1; i < chunks.length; i++) {
        const tail = chunks[i - 1].slice(-overlapChars);
        // Avoid bloating beyond maxChars + overlap budget
        withOverlap.push(tail + '\n\n' + chunks[i]);
      }
      return withOverlap;
    }
    return chunks;
  }

  // -------------------------------------------------------------------------
  // summarizeChunks — try `afm batch` first; on first failure or unknown
  // signature, drop permanently to sequential `afm summarize` (stdin).
  // Returns string[] — same length as input, individual failures become ''.
  // -------------------------------------------------------------------------
  async summarizeChunks(chunks) {
    if (!Array.isArray(chunks) || chunks.length === 0) return [];

    // Attempt afm batch ONCE per processor lifetime, then memoize result.
    if (this._batchMode === null) {
      try {
        const result = await this._tryBatchSummarize(chunks);
        if (Array.isArray(result) && result.length === chunks.length) {
          this._batchMode = true;
          return result.map(s => this._trimSummary(s));
        }
        this._batchMode = false;
      } catch (e) {
        console.warn('[zeus/hierarchical] afm batch unavailable, falling back to sequential summarize:', e.message);
        this._batchMode = false;
      }
    }

    if (this._batchMode === true) {
      try {
        const result = await this._tryBatchSummarize(chunks);
        if (Array.isArray(result) && result.length === chunks.length) {
          return result.map(s => this._trimSummary(s));
        }
      } catch (e) {
        console.warn('[zeus/hierarchical] afm batch failed mid-flight, sequential fallback:', e.message);
      }
    }

    // Sequential fallback — Promise serial (NOT Promise.all; we want to keep
    // FoundationModels single-session friendly and avoid thrash).
    const summaries = [];
    for (let i = 0; i < chunks.length; i++) {
      try {
        const out = await execAfm(
          this.afmBin,
          ['summarize', '--max-tokens', '100', '--deterministic'],
          chunks[i],
          DEFAULT_TIMEOUT_MS
        );
        summaries.push(this._trimSummary(out));
      } catch (e) {
        console.warn('[zeus/hierarchical] summarize chunk ' + i + ' failed:', e.message);
        // Best-effort partial: keep a degraded extract (head of chunk)
        summaries.push(this._fallbackExtract(chunks[i]));
      }
    }
    return summaries;
  }

  // afm batch signature: per `afm --help`, "Process multiple files in parallel
  // via independent FM sessions". The CLI shape is not fully documented in the
  // plugin source — we attempt the most natural shape (files via temp dir) and
  // give up gracefully if exit ≠ 0 or output cannot be aligned to chunks.
  async _tryBatchSummarize(chunks) {
    if (!fs || !path || !nodeOs) {
      throw new Error('hierarchical._tryBatchSummarize: fs/path/os unavailable (iOS sandbox)');
    }
    const tmpDir = fs.mkdtempSync(path.join(nodeOs.tmpdir(), 'zeus-batch-'));
    const filePaths = [];
    try {
      for (let i = 0; i < chunks.length; i++) {
        const p = path.join(tmpDir, 'chunk-' + String(i).padStart(4, '0') + '.txt');
        fs.writeFileSync(p, chunks[i], 'utf8');
        filePaths.push(p);
      }
      // Most plausible signature: `afm batch summarize <files...> --max-tokens N`
      // If the binary uses a different verb arrangement (e.g., `afm summarize
      // --batch <dir>`), this will fail fast and we drop to sequential.
      const out = await execAfm(
        this.afmBin,
        ['batch', 'summarize', '--max-tokens', '100', '--deterministic', ...filePaths],
        null,
        DEFAULT_TIMEOUT_MS * 2
      );
      // Try to parse JSON object/array first; fall back to newline-aligned text.
      const parsed = this._parseBatchOutput(out, filePaths);
      if (parsed && parsed.length === chunks.length) return parsed;
      return null;
    } finally {
      // Always clean up temp dir
      try {
        for (const fp of filePaths) { try { fs.unlinkSync(fp); } catch {} }
        fs.rmdirSync(tmpDir);
      } catch {}
    }
  }

  _parseBatchOutput(out, filePaths) {
    // Shape 1: JSON array of strings or {file, summary} objects
    try {
      const j = JSON.parse(out);
      if (Array.isArray(j)) {
        if (typeof j[0] === 'string') return j;
        if (j[0] && typeof j[0] === 'object') {
          return j.map(x => x.summary || x.tldr || x.text || '');
        }
      }
      if (j && typeof j === 'object' && j.results) {
        return j.results.map(r => r.summary || r.tldr || r.text || (typeof r === 'string' ? r : ''));
      }
    } catch { /* not JSON */ }
    // Shape 2: blank-line separated blocks, one per file, in input order
    const blocks = out.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
    if (blocks.length === filePaths.length) return blocks;
    return null;
  }

  _trimSummary(s) {
    if (typeof s !== 'string') return '';
    let t = s.trim();
    if (t.length > SUMMARY_TARGET_CHARS) {
      // Cut at last sentence boundary within budget
      const slice = t.slice(0, SUMMARY_TARGET_CHARS);
      const lastDot = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
      t = lastDot > SUMMARY_TARGET_CHARS / 2 ? slice.slice(0, lastDot + 1) : slice;
    }
    return t;
  }

  _fallbackExtract(text) {
    // Degraded summary when afm fails entirely — keep first paragraph or head
    const firstPara = text.split(/\n\s*\n/)[0] || text;
    return firstPara.slice(0, SUMMARY_TARGET_CHARS).trim();
  }

  // -------------------------------------------------------------------------
  // recursiveReduce — joined summaries may STILL exceed maxChunkChars on
  // very large docs (e.g., 50-chunk note → 50×300 ≈ 15KB joined). Recur up
  // to maxIter times, re-chunking and re-summarizing.
  // -------------------------------------------------------------------------
  async recursiveReduce(summaries, maxIter = RECURSIVE_REDUCE_MAX_ITER) {
    if (!Array.isArray(summaries) || summaries.length === 0) return '';
    let joined = summaries.filter(s => s && s.trim()).join('\n\n');
    let iter = 0;
    while (joined.length > this.maxChunkChars && iter < maxIter) {
      const subChunks = this.chunkText(joined, this.maxChunkChars, 100);
      if (subChunks.length <= 1) break; // can't reduce further
      const subSummaries = await this.summarizeChunks(subChunks);
      joined = subSummaries.filter(s => s && s.trim()).join('\n\n');
      iter++;
    }
    // Final hard trim if still oversized — better truncated than overflow
    if (joined.length > FINAL_SUMMARY_TARGET_CHARS) {
      joined = joined.slice(0, FINAL_SUMMARY_TARGET_CHARS);
      const lastDot = joined.lastIndexOf('. ');
      if (lastDot > FINAL_SUMMARY_TARGET_CHARS / 2) joined = joined.slice(0, lastDot + 1);
    }
    return joined;
  }

  // -------------------------------------------------------------------------
  // enrichSummary — write the reduced summary to a temp .md inside vaultRoot
  // (so `afm enrich --vault <root>` can resolve it as a vault path), call
  // enrich, parse JSON, ALWAYS delete the temp file in finally{}.
  // -------------------------------------------------------------------------
  async enrichSummary(summary, vaultRoot) {
    if (!summary || !vaultRoot) {
      return { suggested_links: [], suggested_tags: [], connections: [] };
    }
    if (!fs || !path) {
      throw new Error('hierarchical.enrichSummary: fs/path unavailable (iOS sandbox)');
    }
    const tag = sha8(summary + ':' + Date.now());
    const tempBaseName = '.zeus-temp-' + tag + '.md';
    const tempAbs = path.join(vaultRoot, tempBaseName);

    try {
      fs.writeFileSync(tempAbs, summary, 'utf8');
      const out = await execAfm(
        this.afmBin,
        ['enrich', tempBaseName, '--vault', vaultRoot, '--prewarm', '--deterministic'],
        null,
        DEFAULT_TIMEOUT_MS
      );
      try {
        return JSON.parse(out);
      } catch (e) {
        console.warn('[zeus/hierarchical] enrich non-JSON output:', out.slice(0, 200));
        return { suggested_links: [], suggested_tags: [], connections: [] };
      }
    } catch (e) {
      console.warn('[zeus/hierarchical] enrichSummary failed:', e.message);
      return { suggested_links: [], suggested_tags: [], connections: [] };
    } finally {
      // CRITICAL — never leave .zeus-temp-* garbage in the vault.
      try {
        if (fs.existsSync(tempAbs)) fs.unlinkSync(tempAbs);
      } catch (e) {
        console.warn('[zeus/hierarchical] temp cleanup failed for', tempAbs, e.message);
      }
    }
  }

  // -------------------------------------------------------------------------
  // processLargeDoc — top-level entry point used by ZeusEnricher when a
  // note exceeds the 4096-token FM window. Returns an enrich-shaped object
  // augmented with { source: 'hierarchical', chunks: N }.
  // -------------------------------------------------------------------------
  async processLargeDoc(filePath, vaultRoot) {
    if (!fs || !path) {
      throw new Error('hierarchical.processLargeDoc: fs/path unavailable (iOS sandbox)');
    }
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(vaultRoot, filePath);
    let text;
    try {
      text = fs.readFileSync(absPath, 'utf8');
    } catch (e) {
      throw new Error('processLargeDoc: cannot read ' + absPath + ' — ' + e.message);
    }
    // Strip frontmatter — same convention as main.js
    const stripped = text.replace(/^---\n[\s\S]*?\n---\n/, '');

    const chunks = this.chunkText(stripped, this.maxChunkChars, 200);
    if (chunks.length === 0) {
      return {
        suggested_links: [], suggested_tags: [], connections: [],
        source: 'hierarchical', chunks: 0,
      };
    }
    if (chunks.length === 1) {
      // Doc fits — go straight to enrich without summarization round-trip.
      const enriched = await this.enrichSummary(chunks[0], vaultRoot);
      return Object.assign(
        { suggested_links: [], suggested_tags: [], connections: [] },
        enriched,
        { source: 'hierarchical', chunks: 1 }
      );
    }

    let summaries;
    try {
      summaries = await this.summarizeChunks(chunks);
    } catch (e) {
      console.warn('[zeus/hierarchical] summarizeChunks unrecoverable:', e.message);
      summaries = chunks.map(c => this._fallbackExtract(c));
    }

    const reduced = await this.recursiveReduce(summaries, RECURSIVE_REDUCE_MAX_ITER);
    if (!reduced || reduced.trim().length === 0) {
      return {
        suggested_links: [], suggested_tags: [], connections: [],
        source: 'hierarchical', chunks: chunks.length,
        skipped: true, reason: 'all chunk summaries failed',
      };
    }

    const enriched = await this.enrichSummary(reduced, vaultRoot);
    return Object.assign(
      { suggested_links: [], suggested_tags: [], connections: [] },
      enriched,
      { source: 'hierarchical', chunks: chunks.length }
    );
  }
}

module.exports = HierarchicalProcessor;
