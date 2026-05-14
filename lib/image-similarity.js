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
 * v0.11 — universal Mac+iOS: substituído fs/path/crypto por lib/universal-fs +
 * vault.adapter. Métodos viraram async. visionFeaturePrint extraction só funciona
 * onde o daemon estiver acessível — em iOS funciona se o daemon está em Tailscale.
 *
 * Dependências:
 *   - ZeusHttpClient: visionFeaturePrint(imagePath) → {feature_print: [...], dim}
 *   - plugin.indexer.enumerateFiles(): lista todos arquivos do vault
 *   - plugin.app.vault.adapter: file I/O
 *
 * API pública:
 *   new ImageSimilaritySearch(plugin)
 *   await isearch.indexAllImages(onProgress?) → indexa todas imagens, escreve cache
 *   await isearch.findSimilar(imagePath, topK=10) → [{rel, similarity}, ...]
 *   await isearch.loadCache() / await isearch.saveCache()
 *   isearch.size() → contagem em cache
 */

'use strict';

const universal = require('./universal-fs');

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

class ImageSimilaritySearch {
  constructor(plugin) {
    this.plugin = plugin;
    this.cache = new Map(); // rel → {sha, dim, vector, indexedAt}
    this.loaded = false;
  }

  get _adapter() {
    return this.plugin.app.vault.adapter;
  }

  _cachePath() {
    return universal.joinPath(this.plugin.manifest.dir, 'data', CACHE_FILE);
  }

  size() {
    return this.cache.size;
  }

  async _sha256OfFile(rel) {
    try {
      // Use stat fingerprint instead of full binary read — same logic the indexer uses
      // (binary reads on iCloud-synced files can be slow + the indexer already uses
      // path+mtime+size as the cache key, not full content hash).
      const stat = await universal.adapterStat(this._adapter, rel);
      if (!stat) return '';
      return await universal.sha256Hex(`${rel}:${stat.mtime || 0}:${stat.size || 0}`);
    } catch {
      return '';
    }
  }

  async loadCache() {
    this.cache.clear();
    const p = this._cachePath();
    if (!(await universal.adapterExists(this._adapter, p))) { this.loaded = true; return 0; }
    try {
      const raw = await universal.adapterRead(this._adapter, p);
      const lines = raw.split('\n');
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

  async saveCache() {
    const p = this._cachePath();
    try {
      await universal.adapterMkdir(this._adapter, universal.dirname(p));
      const lines = [];
      for (const [rel, v] of this.cache.entries()) {
        lines.push(JSON.stringify({ rel, sha: v.sha, dim: v.dim, vector: v.vector, indexedAt: v.indexedAt }));
      }
      await universal.adapterWriteAtomic(this._adapter, p, lines.join('\n') + (lines.length ? '\n' : ''));
    } catch (e) {
      console.warn('[zeus image-similarity] saveCache failed:', e.message);
    }
  }

  _isImage(rel) {
    const ext = (rel.split('.').pop() || '').toLowerCase();
    return IMAGE_EXTS.has(ext);
  }

  async enumerateImages() {
    // Reuse indexer.enumerateFiles, then filter for images — independent
    // of fileTypes toggles (Zeus indexer may be md/pdf-focused).
    const out = [];
    const exclusions = new Set(this.plugin.settings.folderExclusions || []);
    const skipNames = new Set([...exclusions, '.DS_Store']);
    const allFiles = await universal.adapterWalk(this._adapter, '', skipNames);
    for (const rel of allFiles) {
      if (this._isImage(rel)) out.push({ rel });
    }
    return out;
  }

  async indexAllImages(onProgress) {
    if (!this.loaded) await this.loadCache();
    const httpClient = this.plugin.httpClient;
    if (!httpClient) throw new Error('plugin.httpClient ausente — daemon Aegis indisponível');
    const reachable = await httpClient.isAvailable();
    if (!reachable) throw new Error('Daemon Zeus inalcançável — não posso gerar feature-prints');

    const imgs = await this.enumerateImages();
    let processed = 0, indexed = 0, skipped = 0, failed = 0;

    for (const img of imgs) {
      processed++;
      const sha = await this._sha256OfFile(img.rel);
      const prev = this.cache.get(img.rel);
      if (prev && prev.sha === sha && Array.isArray(prev.vector) && prev.vector.length > 0) {
        skipped++;
        if (onProgress && processed % 10 === 0) onProgress({ processed, indexed, skipped, failed, total: imgs.length, current: img.rel });
        continue;
      }
      // Daemon needs an absolute path on macOS. Build it from vault root when possible.
      const abs = this._absForDaemon(img.rel);
      try {
        const r = await httpClient.visionFeaturePrint(abs);
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
      if (indexed > 0 && indexed % 25 === 0) await this.saveCache();
    }
    await this.saveCache();
    return { processed, indexed, skipped, failed, total: imgs.length };
  }

  // Build absolute path for the daemon. On iOS the daemon may not be local, so we
  // pass the vault-relative path and let the daemon resolve via its vault_root config.
  _absForDaemon(relOrAbs) {
    if (universal.IS_NODE && universal.nodePath && this.plugin.vaultRoot) {
      const p = universal.nodePath;
      if (p.isAbsolute(relOrAbs)) return relOrAbs;
      return p.join(this.plugin.vaultRoot, relOrAbs);
    }
    // iOS: daemon must accept vault-relative paths
    return relOrAbs;
  }

  async featurePrintFor(imagePath) {
    // Returns vector for an arbitrary image (may live in vault or outside).
    // First checks cache by sha if image is under vault.
    if (!this.loaded) await this.loadCache();

    // Determine vault-relative rel + absolute path
    let rel = imagePath;
    let abs = imagePath;
    if (universal.IS_NODE && universal.nodePath && this.plugin.vaultRoot) {
      const p = universal.nodePath;
      if (p.isAbsolute(imagePath)) {
        abs = imagePath;
        const candidateRel = p.relative(this.plugin.vaultRoot, imagePath);
        if (candidateRel && !candidateRel.startsWith('..')) rel = candidateRel;
      } else {
        abs = p.join(this.plugin.vaultRoot, imagePath);
        rel = imagePath;
      }
    }

    if (this.cache.has(rel)) {
      const prev = this.cache.get(rel);
      const sha = await this._sha256OfFile(rel);
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
    if (!this.loaded) await this.loadCache();
    if (this.cache.size === 0) {
      throw new Error('Cache de feature-prints vazio — rode indexAllImages() primeiro');
    }
    const qVec = await this.featurePrintFor(imagePath);
    let qRel = null;
    if (universal.IS_NODE && universal.nodePath && this.plugin.vaultRoot) {
      const p = universal.nodePath;
      try {
        const abs = p.isAbsolute(imagePath) ? imagePath : p.join(this.plugin.vaultRoot, imagePath);
        const rel = p.relative(this.plugin.vaultRoot, abs);
        if (!rel.startsWith('..')) qRel = rel;
      } catch {}
    } else {
      qRel = imagePath;
    }
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
