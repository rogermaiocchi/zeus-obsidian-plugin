/*
 * ImageSimilaritySearch — vault-wide image similarity via Apple Vision
 * v0.7.0 — DISRUPTIVO
 *
 * Pre-computa feature-print vectors (VNGenerateImageFeaturePrintRequest, 768-dim típico)
 * para TODAS as imagens do vault e armazena em data/image-features.jsonl (1 linha/imagem,
 * formato {rel, sha, dim, vector, indexedAt}). Permite cosine similarity O(N) sobre
 * o cache para "imagens parecidas com esta".
 *
 * Não substitui nada — é uma camada nova de Zeus que casa com a indexação textual
 * existente (anl embed). Roda apenas em Mac (precisa daemon Swift + Vision). Cache
 * é cross-device readable mas só editável no Mac.
 *
 * Dependências:
 *   - ZeusHttpClient: visionFeaturePrint(imagePath) → {feature_print: [...], dim}
 *   - plugin.indexer.enumerateFiles(): lista todos arquivos do vault
 *   - plugin.vaultRoot, plugin.manifest.dir: paths
 *
 * API pública:
 *   new ImageSimilaritySearch(plugin)
 *   await isearch.indexAllImages(onProgress?) → indexa todas imagens, escreve cache
 *   await isearch.findSimilar(imagePath, topK=10) → [{rel, similarity}, ...]
 *   isearch.loadCache() / isearch.saveCache()
 *   isearch.size() → contagem em cache
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'heic', 'gif', 'webp', 'tiff', 'bmp']);
const CACHE_FILE = 'image-features.jsonl';

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function sha256File(absPath) {
  try {
    const h = crypto.createHash('sha256');
    const buf = fs.readFileSync(absPath);
    h.update(buf);
    return h.digest('hex').slice(0, 16);
  } catch {
    return '';
  }
}

class ImageSimilaritySearch {
  constructor(plugin) {
    this.plugin = plugin;
    this.cache = new Map(); // rel → {sha, dim, vector, indexedAt}
    this.loaded = false;
  }

  _cachePath() {
    return path.join(
      this.plugin.vaultRoot,
      this.plugin.manifest.dir,
      'data',
      CACHE_FILE,
    );
  }

  size() {
    return this.cache.size;
  }

  loadCache() {
    this.cache.clear();
    const p = this._cachePath();
    if (!fs.existsSync(p)) { this.loaded = true; return 0; }
    try {
      const lines = fs.readFileSync(p, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj && obj.rel && Array.isArray(obj.vector)) {
            this.cache.set(obj.rel, {
              sha: obj.sha || '',
              dim: obj.dim || obj.vector.length,
              vector: obj.vector,
              indexedAt: obj.indexedAt || 0,
            });
          }
        } catch { /* skip bad line */ }
      }
    } catch (e) {
      console.warn('[zeus image-similarity] loadCache failed:', e.message);
    }
    this.loaded = true;
    return this.cache.size;
  }

  saveCache() {
    const p = this._cachePath();
    try {
      const dir = path.dirname(p);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const lines = [];
      for (const [rel, v] of this.cache.entries()) {
        lines.push(JSON.stringify({ rel, sha: v.sha, dim: v.dim, vector: v.vector, indexedAt: v.indexedAt }));
      }
      fs.writeFileSync(p, lines.join('\n') + (lines.length ? '\n' : ''));
    } catch (e) {
      console.warn('[zeus image-similarity] saveCache failed:', e.message);
    }
  }

  _isImage(rel) {
    const ext = (rel.split('.').pop() || '').toLowerCase();
    return IMAGE_EXTS.has(ext);
  }

  enumerateImages() {
    // Reutiliza indexer.enumerateFiles, depois filtra para imagens — independente
    // dos toggles de fileTypes (Zeus indexer pode estar focado em md/pdf).
    const out = [];
    const exclusions = new Set(this.plugin.settings.folderExclusions || []);
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (exclusions.has(e.name)) continue;
        if (e.name === '.DS_Store' || e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.isFile() && this._isImage(e.name)) {
          out.push({ abs: full, rel: path.relative(this.plugin.vaultRoot, full) });
        }
      }
    };
    walk(this.plugin.vaultRoot);
    return out;
  }

  async indexAllImages(onProgress) {
    if (!this.loaded) this.loadCache();
    const httpClient = this.plugin.httpClient;
    if (!httpClient) throw new Error('plugin.httpClient ausente — daemon Aegis indisponível');
    const reachable = await httpClient.isAvailable();
    if (!reachable) throw new Error('Daemon Zeus inalcançável — não posso gerar feature-prints');

    const imgs = this.enumerateImages();
    let processed = 0, indexed = 0, skipped = 0, failed = 0;

    for (const img of imgs) {
      processed++;
      const sha = sha256File(img.abs);
      const prev = this.cache.get(img.rel);
      if (prev && prev.sha === sha && Array.isArray(prev.vector) && prev.vector.length > 0) {
        skipped++;
        if (onProgress && processed % 10 === 0) onProgress({ processed, indexed, skipped, failed, total: imgs.length, current: img.rel });
        continue;
      }
      try {
        const r = await httpClient.visionFeaturePrint(img.abs);
        const vector = r && (r.feature_print || r.vector || r.features);
        if (Array.isArray(vector) && vector.length > 0) {
          this.cache.set(img.rel, {
            sha,
            dim: r.dim || vector.length,
            vector,
            indexedAt: Date.now(),
          });
          indexed++;
        } else {
          failed++;
        }
      } catch (e) {
        failed++;
        console.warn('[zeus image-similarity] feature-print failed for', img.rel, e.message);
      }
      if (onProgress) onProgress({ processed, indexed, skipped, failed, total: imgs.length, current: img.rel });
      // periodic save to survive crashes
      if (indexed > 0 && indexed % 25 === 0) this.saveCache();
    }
    this.saveCache();
    return { processed, indexed, skipped, failed, total: imgs.length };
  }

  async featurePrintFor(imagePath) {
    // Returns vector for an arbitrary image (does not necessarily live in vault).
    // First checks cache by sha if image is under vaultRoot.
    if (!this.loaded) this.loadCache();
    const abs = path.isAbsolute(imagePath) ? imagePath : path.join(this.plugin.vaultRoot, imagePath);
    let rel = null;
    try { rel = path.relative(this.plugin.vaultRoot, abs); } catch {}
    if (rel && !rel.startsWith('..') && this.cache.has(rel)) {
      const prev = this.cache.get(rel);
      const sha = sha256File(abs);
      if (sha && prev.sha === sha) return prev.vector;
    }
    const httpClient = this.plugin.httpClient;
    if (!httpClient) throw new Error('plugin.httpClient ausente');
    const r = await httpClient.visionFeaturePrint(abs);
    const vector = r && (r.feature_print || r.vector || r.features);
    if (!Array.isArray(vector) || vector.length === 0) throw new Error('feature-print retornou vazio');
    return vector;
  }

  async findSimilar(imagePath, topK = 10) {
    if (!this.loaded) this.loadCache();
    if (this.cache.size === 0) {
      throw new Error('Cache de feature-prints vazio — rode indexAllImages() primeiro');
    }
    const qVec = await this.featurePrintFor(imagePath);
    let qRel = null;
    try {
      const abs = path.isAbsolute(imagePath) ? imagePath : path.join(this.plugin.vaultRoot, imagePath);
      const r = path.relative(this.plugin.vaultRoot, abs);
      if (!r.startsWith('..')) qRel = r;
    } catch {}
    const scored = [];
    for (const [rel, v] of this.cache.entries()) {
      if (qRel && rel === qRel) continue; // skip self
      const sim = cosine(qVec, v.vector);
      scored.push({ rel, similarity: sim });
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, topK);
  }
}

module.exports = ImageSimilaritySearch;
module.exports.cosine = cosine;
module.exports.IMAGE_EXTS = IMAGE_EXTS;
