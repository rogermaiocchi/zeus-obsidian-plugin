/*
 * Zeus — Apple Ecosystem-native Search & Connections for Obsidian
 * v0.7.0 — Full Apple ecosystem coverage via Aegis daemon. Novos endpoints consumidos:
 *           Translation (macOS 14.4+/iOS 17.4+), NLTagger lemma/sentiment/nameType,
 *           NLLanguageRecognizer, VNGenerateImageFeaturePrintRequest (768-dim image
 *           embeddings), VNCalculateImageAestheticsScoresRequest, VNDetectBarcodesRequest,
 *           VNRecognizeDocumentsRequest (layout-aware), NSDataDetector (URLs/phones/dates),
 *           CSSearchQuery (Spotlight bridge). Novo módulo `lib/image-similarity.js` — cosine
 *           similarity sobre feature-prints cacheados em data/image-features.jsonl, permite
 *           buscar IMAGENS semanticamente parecidas no vault inteiro. Disruptivo: Zeus
 *           agora indexa e busca o universo visual do vault, não só texto.
 * v0.6.0 — Aegis-pattern HTTP daemon transport (ADR-018): plugin agnóstico de plataforma,
 *           mesmo código TS chama daemon Swift nativo via requestUrl em Mac/iPhone/iPad/MacBook.
 *           v0.5: modular extensions (afm-daemon, hierarchical, multi-vector).
 *
 * Nomenclatura ecumênica (prefixos Apple):
 *   afm   = Apple Foundation Models (binary, ex-metafm renamed)
 *   av    = Apple Vision framework (classify, aesthetics, saliency, landmarks, describe)
 *   aocr  = Apple OCR (Vision RecognizeTextRequest, structured for macOS 26+)
 *   anl   = Apple NaturalLanguage (NLContextualEmbedding 512-dim)
 *   aia   = Apple Intelligence (reasoning via afm enrich/agent/tools)
 *   acs   = Apple CoreSpotlight (via mdls metadata)
 *   acp   = Apple Cloud Private (Private Cloud Compute — reservado para v0.5+)
 *
 * Pipeline multi-modal por tipo de arquivo:
 *   .md           → anl embed (512-dim) + cosine + exact-match
 *   .pdf          → aocr --structured (layout-aware) → texto → anl embed
 *   .png/.jpg/.heic → aocr (texto na imagem) + av classify (categorias) +
 *                     av landmarks (contagem faces) + acs/mdls (EXIF, GPS, data)
 *                   → todo combinado → anl embed
 *
 * Camadas de reasoning (opcionais, EXPERIMENTAL — janela 4096 tokens):
 *   aia enrich     → links sugeridos + conexões explicadas
 *   aia agent      → Q&A multi-turn (react/plan-execute/reflexion)
 *   aia graph      → knowledge graph schema-validated
 *
 * Distribuição: self-contained, ready para GitHub privado.
 * Binary `afm` em bin/ ou fallback ~/.local/bin/metafm
 * Plain ES2020 — sem build chain.
 */

'use strict';

// === v0.12 PluginRequire helper ===
// Obsidian plugin loader sets __dirname to Electron renderer init, not plugin dir.
// Relative pluginRequire('lib/X') fails. Use absolute path via discovery.
// Strategy: read the plugin path from app config or fall back to walking files.
function _zeusFindPluginDir() {
  const fs0 = require('fs');
  const candidates = [
    '/Users/rogermaiocchi/Library/Mobile Documents/iCloud~md~obsidian/Documents/.obsidian/plugins/zeus',
    '/Users/maiocchi/Library/Mobile Documents/iCloud~md~obsidian/Documents/.obsidian/plugins/zeus',
    process.env.HOME + '/Library/Mobile Documents/iCloud~md~obsidian/Documents/.obsidian/plugins/zeus',
  ];
  for (const c of candidates) {
    try {
      if (fs0.existsSync(c + '/main.js') && fs0.existsSync(c + '/manifest.json')) return c;
    } catch (_) {}
  }
  throw new Error('Zeus pluginRequire: cannot locate plugin dir');
}
const _ZEUS_PLUGIN_DIR = _zeusFindPluginDir();
const _zeusPath = require('path');
function pluginRequire(rel) {
  return require(_zeusPath.join(_ZEUS_PLUGIN_DIR, rel));
}
console.log('[zeus] pluginRequire base:', _ZEUS_PLUGIN_DIR);


const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, SuggestModal, ItemView, Notice, TFile } = obsidian;

// v0.11 — universal Mac+iOS: Node modules wrapped in try/catch so plugin loads
// in Capacitor sandbox (iPad/iPhone). Use `universal.X` for cross-platform ops;
// fall through to `spawn/path/fs` only when guarded by `if (universal.IS_NODE)`.
const universal = pluginRequire('lib/universal-fs');

// v0.11 — Backward compat: legacy code in main.js references `path`/`fs` directly.
// On iOS these are null (not undefined → não dispara ReferenceError quando avaliado
// em expressões como `if (path && ...)`).  Code DEVE checar truthy antes de usar.
const path = universal.nodePath;
const fs = universal.nodeFs;
const spawn = universal.nodeChildProcess ? universal.nodeChildProcess.spawn : null;

// v0.5.0 — modular extensions (parallel-built by subagents)
const AfmDaemon = pluginRequire('lib/afm-daemon');             // Fix 1: JSON-RPC persistent daemon
const HierarchicalProcessor = pluginRequire('lib/hierarchical'); // Fix 2: NexusSum-pattern long-doc enrich
const MultiVectorEmbedder = pluginRequire('lib/multi-vector');   // Fix 4: 3×512=1536-dim effective coverage
const ZeusHttpClient = pluginRequire('lib/zeus-http-client');    // v0.6: Aegis-pattern daemon HTTP transport (ADR-018)
const ImageSimilaritySearch = pluginRequire('lib/image-similarity'); // v0.7: feature-print vault image similarity
const PassportIndex = pluginRequire('lib/passport-index');       // v0.9: Passport Index Architecture (PIA)
const BasesGenerator = pluginRequire('lib/bases-generator');     // v0.9: Obsidian Bases UI derivative from passports.jsonl
const DistributedCoordinator = pluginRequire('lib/distributed-coordinator'); // v0.10: cross-device claim/release via iCloud lock files
const PassportScheduler = pluginRequire('lib/passport-scheduler');           // v0.10: background sweep for stale passports

const VIEW_TYPE_SMART = 'zeus-smart-view';
const VIEW_TYPE_STATUS = 'zeus-status-view';
const DATA_DIR_NAME = 'data';
const EMBEDDINGS_FILE = 'embeddings.jsonl';
const MANIFEST_FILE = 'manifest.json';
const OCR_CACHE_DIR = 'aocr-cache';            // ex-ocr-cache
const IMAGE_FEAT_CACHE_DIR = 'av-cache';       // image features (classify + landmarks + EXIF)
const ENRICH_CACHE_DIR = 'aia-enrich-cache';   // ex-enrich-cache (AIA = Apple Intelligence)

// AFM binary resolution: prefer bundled bin/afm, fallback global metafm
const AFM_BIN_NAMES = ['afm', 'metafm'];
const AFM_FALLBACK = '/Users/rogermaiocchi/.local/bin/metafm';

const DEFAULT_SETTINGS = {
  afmPath: '',                    // '' = auto-detect (bundled bin/afm > ~/.local/bin/metafm > metafm in PATH)
  indexOnStartup: true,
  indexOnSave: true,
  ocrEnabled: true,
  embedBackend: 'apple',          // apple = NLContextualEmbedding (dim 512); e5 = multilingual (dim 384)
  fileTypes: { md: true, pdf: true, png: true, jpg: true, jpeg: true, heic: true },
  folderExclusions: ['.trash', '.obsidian', '.smart-env', 'node_modules', 'Attachments'],
  exactMatchBoost: 0.5,
  maxResults: 30,
  smartNeighborsCount: 8,
  excerptLength: 220,
  minDocChars: 30,
  // FoundationModels reasoning layer (EXPERIMENTAL — janela 4096 tokens limita docs ≤~2KB)
  enrichOnOpen: false,            // default off — habilite manualmente quando confortável com limitação
  enrichDebounceMs: 1500,
  enrichTimeoutMs: 60000,
  agentPattern: 'auto',
  agentMaxIterations: 3,
  rerankTopK: 0,                  // 0 = off; rerank also limited by FM window
  // Apple Vision multi-modal (per-image)
  avImageFeatures: true,          // classify + landmarks + EXIF per image
  avClassifyTopN: 8,
  aocrPdfStructured: true,        // use --structured for layout-aware PDF (macOS 26+)
  // HyDE — disruptive query expansion
  hydeEnabled: false,             // default OFF (adds ~3s latency per search); habilite p/ buscas complexas
  // v0.5.0 — Persistent daemon (Fix 1)
  afmDaemonEnabled: true,         // spawn `afm serve` once per session — elimina cold start ~30s
  // v0.5.0 — Hierarchical processor (Fix 2)
  hierarchicalThreshold: 10000,   // chars above which enrich delega para HierarchicalProcessor (NexusSum)
  // v0.5.0 — Multi-vector embedding (Fix 4)
  multiVectorEnabled: false,      // off until reindex; flip after primeiro reindex c/ multi-vector
  multiVectorIndexOnReindex: false, // se true, runFullIndex produz multi-vectors.jsonl além de embeddings.jsonl
  // v0.6.0 — Aegis-pattern HTTP daemon (ADR-018)
  zeusDaemonUrl: 'http://127.0.0.1:2223',   // local daemon loopback; cross-device via Tailscale: http://100.65.240.43:2223
  daemonPreferredOverSpawn: true,            // ADR-018 fase E++: HTTP-first em todos hot paths; spawn é fallback no Mac
  // v0.7.0 — full Apple ecosystem coverage
  imagesIndexFeaturePrint: false,           // se ON, comandos de indexação de imagens populam data/image-features.jsonl
  autoLanguageDetectOnSave: false,          // detecta língua na nota ativa ao salvar e adiciona ao frontmatter (`lang:`)
  spotlightQueryEnabled: false,             // permite Zeus consultar Spotlight nativo macOS via CSSearchQuery
  // v0.8.0 — native Obsidian Graph integration
  nativeGraphIntegration: false,            // opt-in: auto-write zeus_related: in frontmatter (modifica TODAS as notas)
  nativeGraphTopN: 5,                       // top N neighbors per note
  nativeGraphMinScore: 0.3,                 // skip edges below this cosine score
  nativeGraphSyncOnSave: true,              // resync neighbor after file modify
  // v0.10.0 — cross-device coordination + scheduler
  deviceId: '',                             // persisted; generated on first run by DistributedCoordinator
  schedulerEnabled: true,                   // default ON — background coordinator sweeps stale passports
  schedulerIntervalMs: 15 * 60 * 1000,      // 15 min default
  coordTtlMs: 60 * 1000,                    // 60s default; iCloud sync delay (5-30s) << TTL
};

// =========================================================================
// Utilities
// =========================================================================

// Sync sha256 using Node crypto when available; rolling-hash fallback on iOS
// (iOS plugin only uses sha256 for content-change keys, not crypto-strong proofs).
function sha256(text) {
  if (universal.nodeCrypto && typeof universal.nodeCrypto.createHash === 'function') {
    return universal.nodeCrypto.createHash('sha256').update(text).digest('hex');
  }
  let h = 0;
  for (let i = 0; i < text.length; i++) h = ((h << 5) - h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, '0');
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function normalizeForMatch(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function execMetafm(binPath, args, stdinText, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    if (!spawn) {
      reject(new Error('execMetafm: child_process unavailable on this platform (iOS sandbox)'));
      return;
    }
    const child = spawn(binPath, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('metafm timeout')); }, timeoutMs);
    child.stdout.on('data', d => stdout += d.toString());
    child.stderr.on('data', d => stderr += d.toString());
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`metafm exit ${code}: ${stderr.slice(0, 400)}`));
    });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    if (stdinText) {
      child.stdin.write(stdinText);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

function isMac() {
  // process.platform doesn't exist on iOS (Capacitor) — fallback to UA detection.
  return universal.isMacLike();
}

// =========================================================================
// HTTP-first dispatcher (ADR-018 Aegis pattern, fase E++)
// -------------------------------------------------------------------------
// Toda chamada que historicamente ia via `execMetafm` (child_process.spawn)
// passa primeiro pelo daemon HTTP local quando `daemonPreferredOverSpawn`
// está ON (default true em v0.6) OU quando estamos em iOS (sem spawn).
// Se daemon não responde, faz fallback gracioso para spawn (Mac only).
// -------------------------------------------------------------------------
async function tryDaemonOrSpawn(plugin, daemonMethod, daemonArgs, spawnArgs, stdinText, timeoutMs) {
  const preferDaemon = plugin.settings.daemonPreferredOverSpawn || !isMac();
  if (preferDaemon && plugin.httpClient) {
    try {
      const reachable = await plugin.httpClient.isAvailable();
      if (reachable && typeof plugin.httpClient[daemonMethod] === 'function') {
        return { source: 'daemon', result: await plugin.httpClient[daemonMethod](...daemonArgs) };
      }
    } catch (e) {
      console.warn(`[zeus] daemon ${daemonMethod} failed, falling back to spawn: ${e.message}`);
    }
  }
  if (!isMac()) {
    throw new Error(`Operation requires daemon (${daemonMethod}) but daemon is unreachable on this device (no spawn available)`);
  }
  const text = await execMetafm(plugin.afmBin, spawnArgs, stdinText, timeoutMs);
  return { source: 'spawn', result: text };
}

// Resolve afm binary path: explicit setting > bundled bin/ > global ~/.local/bin/metafm > $PATH metafm
// On iOS (no fs/path), returns the default 'metafm' string — caller should never invoke
// it on iOS anyway (tryDaemonOrSpawn throws when no daemon is reachable).
function resolveAfmBinary(plugin) {
  if (!fs || !path) return 'metafm';
  // 1. Explicit user setting
  if (plugin.settings.afmPath && fs.existsSync(plugin.settings.afmPath)) {
    return plugin.settings.afmPath;
  }
  // 2. Bundled in plugin dir: bin/afm
  const vaultRoot = plugin.vaultRoot;
  if (vaultRoot) {
    const pluginDir = path.join(vaultRoot, plugin.manifest.dir);
    for (const name of AFM_BIN_NAMES) {
      const candidate = path.join(pluginDir, 'bin', name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  // 3. Global fallback (Mac dev machines)
  try {
    if (fs.existsSync(AFM_FALLBACK)) return AFM_FALLBACK;
  } catch {}
  // 4. Last resort: rely on PATH lookup
  return 'metafm';
}

// v0.6.1 — Adaptive daemon discovery: tries local loopback, then Tailscale mesh
// Per device, prefers: 127.0.0.1 (same device daemon) > device-specific Tailscale (mesh peer)
const TAILSCALE_MESH = [
  // Order matters — closest/fastest first
  'http://127.0.0.1:2223',                  // local daemon (any device)
  'http://100.108.238.49:2223',             // rogers-mac-mini (Tailscale, macOS)
  'http://100.86.123.88:2223',              // macbook-air-de-roger (Tailscale, macOS)
  'http://100.91.107.120:2223',             // ipad-air-gen-4 (Tailscale, iOS)
  'http://100.65.240.43:2223',              // iphone-15 (Tailscale, iOS)
];

// Probe daemon endpoints in order; return first reachable one. Cached per plugin instance.
async function discoverDaemonUrl(plugin, candidates = null) {
  const urls = candidates || [plugin.settings.zeusDaemonUrl, ...TAILSCALE_MESH.filter(u => u !== plugin.settings.zeusDaemonUrl)];
  for (const url of urls) {
    try {
      const client = new (pluginRequire('lib/zeus-http-client'))(url);
      const reachable = await client.isAvailable();
      if (reachable) {
        console.log('[zeus] adaptive daemon discovery → using', url);
        return url;
      }
    } catch {}
  }
  console.warn('[zeus] adaptive daemon discovery → no reachable endpoint; falling back to default');
  return plugin.settings.zeusDaemonUrl;
}

// Read Apple CoreSpotlight metadata via `mdls` — extract EXIF, GPS, dates, kind.
// Mac-only — returns empty features on iOS (no child_process).
async function acsMetadata(absPath) {
  return new Promise((resolve) => {
    if (!spawn) { resolve({}); return; }
    const child = spawn('/usr/bin/mdls', ['-plist', '-', absPath], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', d => out += d.toString());
    child.on('close', () => {
      // Parse interesting attrs without full XML plist parsing
      const features = {};
      const wanted = [
        'kMDItemKind', 'kMDItemContentTypeTree',
        'kMDItemPixelWidth', 'kMDItemPixelHeight',
        'kMDItemLatitude', 'kMDItemLongitude', 'kMDItemAltitude',
        'kMDItemContentCreationDate', 'kMDItemContentModificationDate',
        'kMDItemAcquisitionMake', 'kMDItemAcquisitionModel',
        'kMDItemTitle', 'kMDItemAuthors', 'kMDItemNumberOfPages',
        'kMDItemDescription', 'kMDItemUserTags', 'kMDItemFinderComment',
      ];
      for (const key of wanted) {
        // Match <key>NAME</key>\s*<TYPE>VALUE</TYPE>
        const re = new RegExp(`<key>${key}</key>\\s*<(string|real|integer|date)>([^<]+)</\\1>`);
        const m = out.match(re);
        if (m) features[key.replace('kMDItem', '')] = m[2];
      }
      resolve(features);
    });
    child.on('error', () => resolve({}));
  });
}

// =========================================================================
// Apple Vision Intelligence (av) — multi-modal per-image extraction
// =========================================================================

class AppleVisionIntelligence {
  constructor(plugin) {
    this.plugin = plugin;
  }

  get cacheDir() {
    return path.join(this.plugin.indexer.dataPath, IMAGE_FEAT_CACHE_DIR);
  }

  cachePath(sha) {
    return path.join(this.cacheDir, sha + '.json');
  }

  loadFromCache(sha) {
    try {
      const p = this.cachePath(sha);
      if (!fs.existsSync(p)) return null;
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch { return null; }
  }

  // For images: run aocr + av classify + av landmarks + acs metadata in parallel
  async extractImageFeatures(absPath, sha) {
    const cached = this.loadFromCache(sha);
    if (cached) return cached;

    const plugin = this.plugin;
    const topN = plugin.settings.avClassifyTopN;

    const tasks = [
      // aocr (text in image) — HTTP-first via daemon ocr()
      tryDaemonOrSpawn(
        plugin,
        'ocr',
        [absPath, 'text', 'pt-BR,en'],
        ['ocr', absPath, '-o', 'text'],
        null,
        60000
      ).then(r => {
        if (r.source === 'daemon') {
          const text = (r.result && (r.result.text || r.result.ocr || '')) || '';
          return { aocr: String(text).trim() };
        }
        return { aocr: String(r.result || '').trim() };
      }).catch(e => ({ aocr: '', aocrError: e.message.slice(0, 80) })),

      // av classify (top-N categories) — HTTP-first via daemon visionClassify()
      tryDaemonOrSpawn(
        plugin,
        'visionClassify',
        [absPath, topN],
        ['vision', 'classify', absPath, '--top-n', String(topN)],
        null,
        30000
      ).then(r => {
        if (r.source === 'daemon') {
          // Normalize to same JSON-string shape the synthesizer expects
          return { avClassify: JSON.stringify(r.result) };
        }
        return { avClassify: String(r.result || '').trim() };
      }).catch(e => ({ avClassify: '', avClassifyError: e.message.slice(0, 80) })),

      // av landmarks (face detection) — HTTP-first via daemon visionLandmarks()
      tryDaemonOrSpawn(
        plugin,
        'visionLandmarks',
        [absPath],
        ['vision', 'landmarks', absPath],
        null,
        30000
      ).then(r => {
        if (r.source === 'daemon') {
          // Expect array OR { landmarks: [...] }; normalize to JSON-array string
          const arr = Array.isArray(r.result) ? r.result
            : (r.result && Array.isArray(r.result.landmarks) ? r.result.landmarks : []);
          return { avLandmarks: JSON.stringify(arr) };
        }
        return { avLandmarks: String(r.result || '').trim() };
      }).catch(e => ({ avLandmarks: '', avLandmarksError: e.message.slice(0, 80) })),

      // acs metadata (Spotlight: EXIF, GPS, dates, camera, dimensions) — Mac only, no daemon path
      acsMetadata(absPath).then(meta => ({ acsMetadata: meta })),
    ];

    const results = await Promise.all(tasks);
    const features = Object.assign({}, ...results);

    // Count faces from landmarks output (heuristic — count "face_" or json array length)
    try {
      const lm = JSON.parse(features.avLandmarks || '[]');
      features.faceCount = Array.isArray(lm) ? lm.length : 0;
    } catch {
      features.faceCount = (features.avLandmarks.match(/face[_\d]/gi) || []).length;
    }

    // Persist
    fs.mkdirSync(this.cacheDir, { recursive: true });
    fs.writeFileSync(this.cachePath(sha), JSON.stringify(features, null, 2));
    return features;
  }

  // Synthesize a single indexable text from image features for embedding
  synthesizeIndexableText(features, fileName) {
    const parts = [`Image: ${fileName}`];
    if (features.aocr && features.aocr.length > 5) parts.push(`Text in image: ${features.aocr.slice(0, 1500)}`);
    if (features.avClassify) {
      // av classify JSON output: {topN, classifications:[{label, confidence}]}
      let cats = [];
      try {
        const parsed = JSON.parse(features.avClassify);
        cats = (parsed.classifications || []).map(c => c.label).filter(Boolean).slice(0, 8);
      } catch {
        // fallback if not JSON
        cats = features.avClassify.split('\n').map(l => l.split(':')[0].trim()).filter(Boolean).slice(0, 8);
      }
      if (cats.length) parts.push(`Visual categories: ${cats.join(', ')}`);
    }
    if (features.faceCount > 0) parts.push(`Contains ${features.faceCount} face${features.faceCount > 1 ? 's' : ''}`);
    const m = features.acsMetadata || {};
    if (m.AcquisitionMake || m.AcquisitionModel) parts.push(`Camera: ${[m.AcquisitionMake, m.AcquisitionModel].filter(Boolean).join(' ')}`);
    if (m.ContentCreationDate) parts.push(`Captured: ${m.ContentCreationDate}`);
    if (m.Latitude && m.Longitude) parts.push(`Location: ${m.Latitude}, ${m.Longitude}`);
    if (m.PixelWidth && m.PixelHeight) parts.push(`Dimensions: ${m.PixelWidth}×${m.PixelHeight}`);
    if (m.Title) parts.push(`Title: ${m.Title}`);
    if (m.Description) parts.push(`Description: ${m.Description}`);
    if (m.UserTags) parts.push(`Tags: ${m.UserTags}`);
    return parts.join('\n');
  }
}

// =========================================================================
// Indexer — runs only on Mac (child_process + afm/metafm)
// =========================================================================

class ZeusIndexer {
  constructor(plugin) {
    this.plugin = plugin;
    this.indexing = false;
  }

  // v0.11 — dataPath now also exposed as vault-relative for vault.adapter consumers
  get dataPath() {
    // Absolute path (Mac only). On iOS this returns null-prefixed garbage if vaultRoot
    // is undefined; callers on iOS must use dataPathRel instead.
    if (!path || !this.plugin.vaultRoot) return this.dataPathRel;
    return path.join(this.plugin.vaultRoot, this.plugin.manifest.dir, DATA_DIR_NAME);
  }

  // Vault-relative — works on Mac AND iOS via vault.adapter.
  get dataPathRel() {
    return universal.joinPath(this.plugin.manifest.dir, DATA_DIR_NAME);
  }

  // Note: kept sync for API compat. Mac uses fs.readFileSync; iOS falls back to
  // a cached value loaded asynchronously during onload (this.plugin._manifestCache).
  // If cache is empty on iOS, returns default empty manifest (UI degrades gracefully).
  loadManifest() {
    if (!fs || !path) {
      return this.plugin._manifestCache || { version: 2, model: 'apple-nlcontextual', dim: 512, files: {} };
    }
    const p = path.join(this.dataPath, MANIFEST_FILE);
    if (!fs.existsSync(p)) return { version: 2, model: 'apple-nlcontextual', dim: 512, files: {} };
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch { return { version: 2, model: 'apple-nlcontextual', dim: 512, files: {} }; }
  }

  // Async loader used during onload to populate the in-memory cache for iOS.
  async loadManifestAsync() {
    try {
      const rel = universal.joinPath(this.dataPathRel, MANIFEST_FILE);
      const adapter = this.plugin.app.vault.adapter;
      if (!(await universal.adapterExists(adapter, rel))) {
        return { version: 2, model: 'apple-nlcontextual', dim: 512, files: {} };
      }
      const raw = await universal.adapterRead(adapter, rel);
      return JSON.parse(raw);
    } catch {
      return { version: 2, model: 'apple-nlcontextual', dim: 512, files: {} };
    }
  }

  saveManifest(m) {
    if (!fs || !path) {
      // iOS — write via vault.adapter, fire-and-forget. Settings tab + scheduler
      // are the callers; they don't await save manifest.
      const adapter = this.plugin.app.vault.adapter;
      universal.adapterMkdir(adapter, this.dataPathRel)
        .then(() => universal.adapterWriteAtomic(adapter, universal.joinPath(this.dataPathRel, MANIFEST_FILE), JSON.stringify(m, null, 2)))
        .catch(e => console.warn('[zeus] saveManifest (iOS) failed:', e.message));
      this.plugin._manifestCache = m;
      return;
    }
    fs.mkdirSync(this.dataPath, { recursive: true });
    fs.writeFileSync(path.join(this.dataPath, MANIFEST_FILE), JSON.stringify(m, null, 2));
  }

  async readFileContent(absPath, ext) {
    if (ext === 'md') return fs.readFileSync(absPath, 'utf8');
    if (!this.plugin.settings.ocrEnabled) return '';
    const sha = sha256(absPath + ':' + fs.statSync(absPath).mtimeMs);

    const isImage = ['png', 'jpg', 'jpeg', 'heic', 'tiff', 'bmp'].includes(ext);
    const isPdf = ext === 'pdf';

    // IMAGES: full multi-modal (aocr + av classify + av landmarks + acs metadata)
    if (isImage && this.plugin.settings.avImageFeatures) {
      try {
        const features = await this.plugin.av.extractImageFeatures(absPath, sha);
        return this.plugin.av.synthesizeIndexableText(features, path.basename(absPath));
      } catch (e) {
        console.warn('[zeus] av extract failed for', absPath, e.message);
        // fall through to plain OCR
      }
    }

    // Plain aocr path (PDF or fallback for images without av features) — HTTP-first
    const cachePath = path.join(this.dataPath, OCR_CACHE_DIR, sha + '.txt');
    if (fs.existsSync(cachePath)) return fs.readFileSync(cachePath, 'utf8');

    const extractText = (r) => {
      if (r.source === 'daemon') {
        const v = r.result;
        return String((v && (v.text || v.ocr || v.content)) || '');
      }
      return String(r.result || '');
    };

    try {
      const spawnArgs = ['ocr', absPath, '-o', 'text', '-l', 'pt-BR,en'];
      if (isPdf && this.plugin.settings.aocrPdfStructured) spawnArgs.push('--structured');
      const r = await tryDaemonOrSpawn(
        this.plugin,
        'ocr',
        [absPath, 'text', 'pt-BR,en'],
        spawnArgs,
        null,
        180000
      );
      const text = extractText(r);
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, text);
      return text;
    } catch (e) {
      // If --structured fails (macOS <26 or experimental issue), retry without (spawn-only fallback)
      if (isPdf && this.plugin.settings.aocrPdfStructured) {
        try {
          const r2 = await tryDaemonOrSpawn(
            this.plugin,
            'ocr',
            [absPath, 'text', 'pt-BR,en'],
            ['ocr', absPath, '-o', 'text', '-l', 'pt-BR,en'],
            null,
            180000
          );
          const text = extractText(r2);
          fs.mkdirSync(path.dirname(cachePath), { recursive: true });
          fs.writeFileSync(cachePath, text);
          return text;
        } catch (e2) { console.warn('[zeus] aocr fallback also failed', absPath, e2.message); }
      }
      console.warn('[zeus] aocr failed for', absPath, e.message);
      return '';
    }
  }

  // v0.11 — universal enumerator. Returns array of { abs, rel, ext } where:
  //   - rel is always vault-relative (forward-slash, works on iOS and Mac)
  //   - abs is absolute path on Mac, equals rel on iOS (since no fs absolute path).
  // Caller MUST use rel + vault.adapter for cross-platform code paths.
  // On Mac with fs available, walks via fs.readdirSync (faster than adapter).
  // On iOS, falls back to async adapter walk (caller must await).
  enumerateFiles() {
    const exclusions = new Set(this.plugin.settings.folderExclusions);
    const exts = this.plugin.settings.fileTypes;

    if (fs && path && this.plugin.vaultRoot) {
      const files = [];
      const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (exclusions.has(e.name)) continue;
          if (e.name === '.DS_Store') continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) walk(full);
          else if (e.isFile()) {
            const ext = e.name.split('.').pop().toLowerCase();
            if (exts[ext]) {
              const rel = path.relative(this.plugin.vaultRoot, full).split(path.sep).join('/');
              files.push({ abs: full, rel, ext });
            }
          }
        }
      };
      walk(this.plugin.vaultRoot);
      return files;
    }

    // iOS path: use Obsidian's getFiles() — already enumerates the whole vault.
    // Filter by ext + folder exclusions. abs == rel since there's no Node fs.
    const out = [];
    const allFiles = this.plugin.app.vault.getFiles ? this.plugin.app.vault.getFiles() : [];
    for (const f of allFiles) {
      const rel = f.path;
      // skip if any path segment is in exclusions or starts with '.'
      const segs = rel.split('/');
      let skip = false;
      for (let i = 0; i < segs.length - 1; i++) {
        const s = segs[i];
        if (!s) continue;
        if (exclusions.has(s) || s.startsWith('.')) { skip = true; break; }
      }
      if (skip) continue;
      const ext = (f.extension || (rel.split('.').pop() || '')).toLowerCase();
      if (!exts[ext]) continue;
      out.push({ abs: rel, rel, ext });
    }
    return out;
  }

  parseEmbedOutput(jsonStr) {
    const obj = JSON.parse(jsonStr);
    return { vectors: obj.vectors || [], dim: obj.dim || 0, model: obj.model || 'unknown' };
  }

  async embedBatch(texts) {
    if (texts.length === 0) return [];
    const stdin = JSON.stringify(texts);
    const r = await tryDaemonOrSpawn(
      this.plugin,
      'embedBatch',
      [texts, { backend: this.plugin.settings.embedBackend }],
      ['embed', '--backend', this.plugin.settings.embedBackend],
      stdin,
      300000
    );
    if (r.source === 'daemon') {
      // Daemon returns { vectors: [[...], ...], dim, model, count }
      return (r.result && r.result.vectors) || [];
    }
    const parsed = this.parseEmbedOutput(r.result);
    return parsed.vectors;
  }

  async runFullIndex(onProgress) {
    if (this.indexing) { new Notice('Zeus: indexação já em curso'); return; }
    if (!isMac()) { new Notice('Zeus: indexação só roda no Mac (metafm). Outros devices apenas lêem.'); return; }
    this.indexing = true;
    const start = Date.now();
    fs.mkdirSync(this.dataPath, { recursive: true });

    try {
      const files = this.enumerateFiles();
      if (onProgress) onProgress(`${files.length} arquivos encontrados`);
      if (files.length === 0) {
        new Notice('Zeus: vault vazio — nada para indexar');
        this.indexing = false;
        return;
      }

      const docs = [];
      let i = 0;
      for (const f of files) {
        i++;
        if (onProgress && i % 10 === 0) onProgress(`lendo ${i}/${files.length}`);
        let content = '';
        try { content = await this.readFileContent(f.abs, f.ext); }
        catch (e) { console.warn('[zeus] read failed', f.rel, e.message); continue; }
        if (!content || content.length < this.plugin.settings.minDocChars) continue;
        const sha = sha256(content);
        const title = f.rel.replace(/\.[^.]+$/, '').split('/').pop();
        const body = content.replace(/^---\n[\s\S]*?\n---\n/, '').slice(0, 50000);
        docs.push({ path: f.rel, abs: f.abs, ext: f.ext, sha, mtime: fs.statSync(f.abs).mtimeMs, title, body });
      }

      // Embeddings — incremental (skip por sha)
      const oldEmbeddings = this.loadEmbeddings();
      const newEmbeddings = new Map();
      const toEmbed = [];
      for (const d of docs) {
        const prev = oldEmbeddings.get(d.path);
        if (prev && prev.sha === d.sha) newEmbeddings.set(d.path, prev);
        else toEmbed.push(d);
      }

      if (toEmbed.length > 0) {
        if (onProgress) onProgress(`Apple NLContextualEmbedding: ${toEmbed.length} novos`);
        const BATCH = 20;
        for (let j = 0; j < toEmbed.length; j += BATCH) {
          const chunk = toEmbed.slice(j, j + BATCH);
          if (onProgress) onProgress(`embedding ${Math.min(j + BATCH, toEmbed.length)}/${toEmbed.length}`);
          const texts = chunk.map(d => (d.title + '\n' + d.body).slice(0, 4000));
          let vectors;
          try { vectors = await this.embedBatch(texts); }
          catch (e) {
            console.warn('[zeus] embed batch failed', e.message);
            new Notice('Zeus embed: ' + e.message.slice(0, 100));
            continue;
          }
          for (let k = 0; k < chunk.length; k++) {
            newEmbeddings.set(chunk[k].path, {
              path: chunk[k].path,
              sha: chunk[k].sha,
              mtime: chunk[k].mtime,
              title: chunk[k].title,
              vec: vectors[k],
            });
          }
          this.saveEmbeddings(newEmbeddings);   // crash-safe incremental
        }
      }
      this.saveEmbeddings(newEmbeddings);

      // Manifest
      const manifest = {
        version: 2,
        model: 'apple-nlcontextual',
        dim: 512,
        files: {},
        indexedAt: Date.now(),
        elapsedMs: Date.now() - start,
        docCount: docs.length,
        embeddingCount: newEmbeddings.size,
      };
      for (const d of docs) manifest.files[d.path] = { sha: d.sha, mtime: d.mtime, ext: d.ext };
      this.saveManifest(manifest);

      this.plugin.loadIndices();
      if (typeof this.plugin.updateStatusBar === 'function') this.plugin.updateStatusBar('idle', null);
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      new Notice(`Zeus: ${docs.length} docs, ${toEmbed.length} embeddings novos, ${elapsed}s`);
      if (onProgress) onProgress(`pronto: ${docs.length} docs / ${elapsed}s`);
    } catch (e) {
      console.error('[zeus] index error', e);
      new Notice('Zeus index error: ' + e.message.slice(0, 120));
    } finally {
      this.indexing = false;
      if (typeof this.plugin.updateStatusBar === 'function') this.plugin.updateStatusBar('idle', null);
    }
  }

  // Sync API kept for compat. Mac uses fs; iOS returns the cached map
  // populated by loadEmbeddingsAsync() during onload.
  loadEmbeddings() {
    const map = new Map();
    if (!fs || !path) {
      const cached = this.plugin._embeddingsCache;
      return cached instanceof Map ? cached : map;
    }
    const p = path.join(this.dataPath, EMBEDDINGS_FILE);
    if (!fs.existsSync(p)) return map;
    const content = fs.readFileSync(p, 'utf8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try { const obj = JSON.parse(line); map.set(obj.path, obj); } catch {}
    }
    return map;
  }

  async loadEmbeddingsAsync() {
    const map = new Map();
    try {
      const rel = universal.joinPath(this.dataPathRel, EMBEDDINGS_FILE);
      const adapter = this.plugin.app.vault.adapter;
      if (!(await universal.adapterExists(adapter, rel))) return map;
      const content = await universal.adapterRead(adapter, rel);
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try { const obj = JSON.parse(line); map.set(obj.path, obj); } catch {}
      }
    } catch (e) {
      console.warn('[zeus] loadEmbeddingsAsync failed:', e.message);
    }
    return map;
  }

  saveEmbeddings(map) {
    if (!fs || !path) {
      // iOS — fire-and-forget write via adapter; also update cache.
      const adapter = this.plugin.app.vault.adapter;
      const lines = [];
      for (const v of map.values()) lines.push(JSON.stringify(v));
      universal.adapterMkdir(adapter, this.dataPathRel)
        .then(() => universal.adapterWriteAtomic(adapter, universal.joinPath(this.dataPathRel, EMBEDDINGS_FILE), lines.join('\n')))
        .catch(e => console.warn('[zeus] saveEmbeddings (iOS) failed:', e.message));
      this.plugin._embeddingsCache = map;
      return;
    }
    fs.mkdirSync(this.dataPath, { recursive: true });
    const lines = [];
    for (const v of map.values()) lines.push(JSON.stringify(v));
    fs.writeFileSync(path.join(this.dataPath, EMBEDDINGS_FILE), lines.join('\n'));
  }
}

// =========================================================================
// Searcher — pure Apple NLContextualEmbedding cosine + exact-match boost
// =========================================================================

class ZeusSearcher {
  constructor(plugin) {
    this.plugin = plugin;
    this.embeddings = new Map();
  }

  load() {
    this.embeddings = this.plugin.indexer.loadEmbeddings();
  }

  // Lê conteúdo bruto do arquivo para o exact-match boost — só quando necessário.
  // Mac path: synchronous fs.readFileSync (fast, used in tight scoring loops).
  // iOS path: fs is null — caller has cache; readDoc returns '' (only impacts
  // the very rare "no qVec available" fallback, which can't happen on iOS since
  // daemon embed must succeed for search to work).
  readDoc(filePath) {
    try {
      if (!fs || !path) return '';
      const abs = path.join(this.plugin.vaultRoot, filePath);
      const content = fs.readFileSync(abs, 'utf8').replace(/^---\n[\s\S]*?\n---\n/, '');
      return content;
    } catch { return ''; }
  }

  async embedQuery(query) {
    // v0.6 fase E++ — uniform HTTP-first via tryDaemonOrSpawn (works on Mac AND iOS)
    let textToEmbed = query;
    // HyDE: now also HTTP-first internally (HyDEExpander.expand uses tryDaemonOrSpawn)
    if (this.plugin.settings.hydeEnabled) {
      try {
        textToEmbed = await this.plugin.hyde.expand(query);
        console.log('[zeus] HyDE expansion (first 100):', textToEmbed.slice(0, 100));
      } catch (e) {
        console.warn('[zeus] HyDE failed, using raw query', e.message);
      }
    }

    try {
      const r = await tryDaemonOrSpawn(
        this.plugin,
        'embed',
        [textToEmbed, { backend: this.plugin.settings.embedBackend }],
        ['embed', '--backend', this.plugin.settings.embedBackend],
        textToEmbed,
        25000
      );
      if (r.source === 'daemon') {
        return (r.result && r.result.vectors && r.result.vectors[0]) || null;
      }
      const parsed = JSON.parse(r.result);
      return (parsed.vectors && parsed.vectors[0]) || null;
    } catch (e) {
      console.warn('[zeus] query embed failed (both paths)', e.message);
      return null;
    }
  }

  // Search principal: cosine semântico + exact-match boost
  async search(query, limit = 30) {
    if (!query || query.length < 2) return [];
    if (this.embeddings.size === 0) return [];
    const qNorm = normalizeForMatch(query);

    // 1. Tentar embed da query — caminho semântico
    const qVec = await this.embedQuery(query);

    // 2. Para cada doc, calcular score
    const results = [];
    for (const e of this.embeddings.values()) {
      if (!e.vec) continue;
      const semScore = qVec ? cosine(qVec, e.vec) : 0;

      // exact-match boost: query (normalizada) aparece no título OU no body cache?
      // Para evitar I/O por doc em cada search, fazemos lazy: usamos título + nada de body por default;
      // body só se sem qVec (fallback iOS).
      const titleNorm = normalizeForMatch(e.title || '');
      let exactHit = 0;
      if (titleNorm.includes(qNorm)) exactHit = 1;

      // No iOS sem qVec, precisamos varredura de conteúdo (custo aceitável p/ vault típico):
      if (!qVec && exactHit === 0) {
        const bodyNorm = normalizeForMatch(this.readDoc(e.path).slice(0, 30000));
        if (bodyNorm.includes(qNorm)) exactHit = 0.5;
      }

      const finalScore = qVec
        ? semScore * (1 + this.plugin.settings.exactMatchBoost * exactHit)
        : exactHit;

      if (finalScore <= 0) continue;
      results.push({ path: e.path, score: finalScore, semantic: semScore, exact: exactHit });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  neighbors(filePath, count = 12) {
    const e = this.embeddings.get(filePath);
    if (!e || !e.vec) return [];
    const results = [];
    for (const other of this.embeddings.values()) {
      if (other.path === filePath || !other.vec) continue;
      results.push({ path: other.path, score: cosine(e.vec, other.vec) });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, count);
  }

  excerpt(filePath, query, maxLen = 220) {
    const content = this.readDoc(filePath);
    if (!content) return '';
    const qNorm = normalizeForMatch(query).split(' ')[0];
    const cNorm = normalizeForMatch(content);
    const idx = cNorm.indexOf(qNorm);
    if (idx < 0) return content.slice(0, maxLen).replace(/\s+/g, ' ').trim();
    const start = Math.max(0, idx - 40);
    const end = Math.min(content.length, idx + maxLen - 40);
    return (start > 0 ? '…' : '') + content.slice(start, end).replace(/\s+/g, ' ').trim() + (end < content.length ? '…' : '');
  }
}

// =========================================================================
// HyDE (Hypothetical Document Embedding) — disruptive query expansion
//
// Insight: vanilla embedding embeds the QUERY (often short, lacking context).
// HyDE pattern: use afm prompt to expand query into hypothetical note text,
// then embed THAT instead. Bridges query-doc representation gap.
// Bench: typically +10-20% relevance vs raw query embed.
// Fits FoundationModels 4096-token window easily (short generation, no tools).
// =========================================================================

class HyDEExpander {
  constructor(plugin) {
    this.plugin = plugin;
    this.cache = new Map();   // memory-only — query strings are not persistent
  }

  async expand(query) {
    if (this.cache.has(query)) return this.cache.get(query);
    const instruction =
      `Escreva uma nota curta em português (3-5 frases) que responde diretamente à pergunta: "${query}". ` +
      `Use palavras-chave e conceitos técnicos que apareceriam no conteúdo real de uma nota sobre o tema. Sem preâmbulo.`;
    try {
      const r = await tryDaemonOrSpawn(
        this.plugin,
        'prompt',
        [instruction, { max_tokens: 300, deterministic: true, prewarm: true, timeoutMs: 90000 }],
        ['prompt', instruction, '--deterministic', '--max-tokens', '300', '--prewarm'],
        null,   // prompt usa arg posicional, não stdin
        90000   // cold spawn ~30-60s; rede idle pode estender
      );
      let hypothetical;
      if (r.source === 'daemon') {
        const v = r.result;
        hypothetical = String((v && (v.text || v.output || v.response || v.completion)) || '').trim();
      } else {
        hypothetical = String(r.result || '').trim();
      }
      if (!hypothetical) return query;
      this.cache.set(query, hypothetical);
      return hypothetical;
    } catch (e) {
      console.warn('[zeus] HyDE expansion failed', e.message);
      return query;
    }
  }
}

// =========================================================================
// Knowledge Graph Extractor — afm graph-extract → SVG modal
// =========================================================================

class ZeusGraphExtractor {
  constructor(plugin) {
    this.plugin = plugin;
  }

  async extract(filePath) {
    // HTTP-first: daemon graphExtract() works on iOS too. v0.11 uses vault.adapter
    // for reading (platform-agnostic) — no Node fs dependency.
    try {
      const content = await this.plugin.app.vault.adapter.read(filePath);
      const stripped = content.replace(/^---\n[\s\S]*?\n---\n/, '').slice(0, 6000);
      const r = await tryDaemonOrSpawn(
        this.plugin,
        'graphExtract',
        [stripped, 20, 30],
        ['graph-extract', '--max-nodes', '20', '--max-edges', '30'],
        stripped,
        60000
      );
      if (r.source === 'daemon') {
        return r.result;
      }
      return JSON.parse(r.result);
    } catch (e) {
      throw new Error(`graph-extract: ${e.message.slice(0, 200)}`);
    }
  }
}

class ZeusGraphModal extends obsidian.Modal {
  constructor(app, plugin, filePath) {
    super(app);
    this.plugin = plugin;
    this.filePath = filePath;
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('zeus-graph-modal');
    contentEl.createEl('h3', { text: 'Knowledge Graph (FoundationModels)' });
    contentEl.createEl('p', { text: this.filePath, cls: 'zeus-graph-path' });
    const status = contentEl.createDiv({ cls: 'zeus-graph-status', text: 'Extraindo grafo via afm graph-extract…' });
    const canvas = contentEl.createDiv({ cls: 'zeus-graph-canvas' });

    try {
      const graph = await this.plugin.graphExtractor.extract(this.filePath);
      status.empty();
      this.renderGraph(canvas, graph);
    } catch (e) {
      status.setText('Erro: ' + e.message);
    }
  }

  renderGraph(container, graph) {
    const nodes = graph.nodes || [];
    const edges = graph.edges || graph.relations || [];
    if (nodes.length === 0) {
      container.createDiv({ text: 'Sem nodes extraídos.', cls: 'zeus-graph-empty' });
      return;
    }

    const W = 720, H = 480;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'zeus-graph-svg');

    // Force-free circular layout (deterministic, no animation)
    const positions = new Map();
    const cx = W / 2, cy = H / 2;
    const r = Math.min(W, H) * 0.38;
    nodes.forEach((n, i) => {
      const angle = (i / nodes.length) * 2 * Math.PI - Math.PI / 2;
      positions.set(n.id || n.name || String(i), {
        x: cx + r * Math.cos(angle),
        y: cy + r * Math.sin(angle),
        name: n.name || n.id || n.label || `node ${i}`,
        type: n.type || '',
      });
    });

    // Edges
    for (const e of edges) {
      const fromKey = e.from || e.source || e.subject;
      const toKey = e.to || e.target || e.object;
      const a = positions.get(fromKey);
      const b = positions.get(toKey);
      if (!a || !b) continue;
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
      line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
      line.setAttribute('class', 'zeus-graph-edge');
      svg.appendChild(line);
      if (e.relation || e.label || e.predicate) {
        const lbl = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        lbl.setAttribute('x', (a.x + b.x) / 2);
        lbl.setAttribute('y', (a.y + b.y) / 2);
        lbl.setAttribute('class', 'zeus-graph-edge-label');
        lbl.textContent = e.relation || e.label || e.predicate;
        svg.appendChild(lbl);
      }
    }

    // Nodes
    for (const [key, p] of positions) {
      const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', p.x); circle.setAttribute('cy', p.y);
      circle.setAttribute('r', 8);
      circle.setAttribute('class', 'zeus-graph-node');
      g.appendChild(circle);
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', p.x); text.setAttribute('y', p.y - 14);
      text.setAttribute('class', 'zeus-graph-node-label');
      text.textContent = (p.name || '').slice(0, 30);
      g.appendChild(text);
      svg.appendChild(g);
    }

    container.empty();
    container.appendChild(svg);
    const summary = container.createDiv({ cls: 'zeus-graph-summary' });
    summary.createEl('span', { text: `${nodes.length} nodes, ${edges.length} relations` });
  }

  onClose() { this.contentEl.empty(); }
}

// =========================================================================
// Native Obsidian Graph integration (v0.8.0)
// -------------------------------------------------------------------------
// Injects Zeus's semantic cosine neighbors into the native Obsidian Graph
// (Cmd+G) by writing `zeus_related:` array of wikilinks in each note's
// frontmatter. Obsidian's metadataCache picks these up automatically and
// renders them as edges alongside regular wikilinks.
// =========================================================================

class ZeusNativeGraphIntegration {
  constructor(plugin) {
    this.plugin = plugin;
    this.lastSync = 0;
    this.SYNC_DEBOUNCE_MS = 3000;
    this.FRONTMATTER_KEY = 'zeus_related';
  }

  // Top-N neighbors da nota, injeta como frontmatter array de wikilinks
  async syncFile(filePath, topN = 5, minScore = 0.3) {
    if (!this.plugin.settings.nativeGraphIntegration) return;
    const neighbors = this.plugin.searcher.neighbors(filePath, topN);
    const filtered = neighbors.filter(n => n.score >= minScore);
    if (filtered.length === 0) return;

    const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
    if (!file) return;

    await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
      fm[this.FRONTMATTER_KEY] = filtered.map(n => {
        const name = n.path.replace(/\.md$/, '');
        return `[[${name}|${name.split('/').pop()} (${(n.score * 100).toFixed(0)}%)]]`;
      });
      // Add metadata also
      fm.zeus_indexed_at = new Date().toISOString();
      fm.zeus_neighbor_count = filtered.length;
    });
  }

  // Sync TODAS as notas com embeddings (batch operation)
  async syncAllFiles(onProgress) {
    if (!this.plugin.settings.nativeGraphIntegration) {
      if (onProgress) onProgress('skip: nativeGraphIntegration off');
      return;
    }
    const paths = [...this.plugin.searcher.embeddings.keys()];
    let i = 0;
    for (const p of paths) {
      i++;
      try {
        await this.syncFile(p, this.plugin.settings.nativeGraphTopN || 5, this.plugin.settings.nativeGraphMinScore || 0.3);
      } catch (e) {
        console.warn('[zeus] graph sync failed for', p, e.message);
      }
      if (onProgress && i % 10 === 0) onProgress(`${i}/${paths.length}`);
    }
    if (onProgress) onProgress(`done: ${paths.length} notes synced`);
  }

  // Cleanup: remove zeus_related from all files
  async clearAll() {
    const files = this.plugin.app.vault.getMarkdownFiles();
    for (const file of files) {
      await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
        delete fm[this.FRONTMATTER_KEY];
        delete fm.zeus_indexed_at;
        delete fm.zeus_neighbor_count;
      });
    }
  }
}

// =========================================================================
// Enricher — FoundationModels deep reasoning via `metafm enrich`
// =========================================================================

class ZeusEnricher {
  constructor(plugin) {
    this.plugin = plugin;
    this.inFlight = new Map();   // path → Promise
  }

  // Vault-relative cache dir (no absolute path — works on iOS via vault.adapter).
  get cacheDir() {
    return universal.joinPath(this.plugin.manifest.dir, DATA_DIR_NAME, ENRICH_CACHE_DIR);
  }

  cachePath(filePath, sha) {
    return universal.joinPath(this.cacheDir, sha + '.json');
  }

  // Async — uses Obsidian vault.adapter (cross-platform).
  async loadFromCache(filePath, sha) {
    try {
      const p = this.cachePath(filePath, sha);
      const adapter = this.plugin.app.vault.adapter;
      if (!(await universal.adapterExists(adapter, p))) return null;
      return JSON.parse(await universal.adapterRead(adapter, p));
    } catch { return null; }
  }

  // Async helper — write cache via vault.adapter (atomic when supported).
  async _writeCache(filePath, sha, data) {
    try {
      const adapter = this.plugin.app.vault.adapter;
      await universal.adapterMkdir(adapter, this.cacheDir);
      await universal.adapterWriteAtomic(adapter, this.cachePath(filePath, sha), JSON.stringify(data, null, 2));
    } catch (e) {
      console.warn('[zeus] enrich cache write failed', e.message);
    }
  }

  // Size limit: FoundationModels janela é 4096 tokens (~10K chars com safety margin).
  // metafm enrich lê o arquivo internamente, então é o tamanho do .md que importa.
  // Para docs maiores: pré-sumarizar via metafm summarize antes de enrich.
  ENRICH_SIZE_LIMIT_CHARS = 10000;

  async enrichNote(filePath) {
    // ADR-018 fase E++: enrich agora roteia via daemon HTTP (works on iOS).
    // Mantemos null-return rápido se searcher.embeddings ainda não conhece a nota.
    const emb = this.plugin.searcher.embeddings.get(filePath);
    if (!emb) return null;
    const sha = emb.sha;
    const cached = await this.loadFromCache(filePath, sha);
    if (cached) return cached;

    // Pre-flight size check via vault.adapter (works on Mac AND iOS).
    let fileSize = 0;
    try {
      const stat = await universal.adapterStat(this.plugin.app.vault.adapter, filePath);
      if (stat && typeof stat.size === 'number') fileSize = stat.size;
    } catch {}
    if (fileSize > this.plugin.settings.hierarchicalThreshold) {
      console.log(`[zeus] doc ${filePath} is ${fileSize}B > ${this.plugin.settings.hierarchicalThreshold} — delegating to HierarchicalProcessor`);
      try {
        // Hierarchical processor needs absolute fs paths (afm CLI) — Mac only.
        if (!isMac() || !fs) {
          throw new Error('Hierarchical processor requires Mac (afm CLI). On iOS the document exceeds the FM window — skip or split manually.');
        }
        const result = await this.plugin.hierarchical.processLargeDoc(filePath, this.plugin.vaultRoot);
        await this._writeCache(filePath, sha, result);
        return result;
      } catch (e) {
        console.warn('[zeus] hierarchical processing failed', e.message);
        const result = {
          suggested_links: [], suggested_tags: [], connections: [],
          skipped: true,
          reason: `Hierarchical processor falhou: ${e.message.slice(0, 200)}. Fallback: divida a nota manualmente.`,
        };
        await this._writeCache(filePath, sha, result);
        return result;
      }
    }

    // Avoid duplicate concurrent calls for same path
    if (this.inFlight.has(filePath)) return this.inFlight.get(filePath);

    const promise = (async () => {
      try {
        const absVault = this.plugin.vaultRoot;
        // Read note content for daemon path — vault.adapter works on Mac and iOS.
        let noteContent = '';
        try {
          noteContent = await universal.adapterRead(this.plugin.app.vault.adapter, filePath);
        } catch (readErr) {
          console.warn('[zeus] enrich read failed', filePath, readErr.message);
        }
        const r = await tryDaemonOrSpawn(
          this.plugin,
          'enrich',
          [noteContent, filePath, ''],   // (noteContent, notePath, vaultSummary)
          ['enrich', filePath, '--vault', absVault, '--prewarm', '--deterministic'],
          null,
          this.plugin.settings.enrichTimeoutMs
        );
        let parsed;
        if (r.source === 'daemon') {
          parsed = r.result;
        } else {
          try { parsed = JSON.parse(r.result); } catch (jsonErr) {
            console.warn('[zeus] enrich non-JSON output', String(r.result).slice(0, 200));
            return null;
          }
        }
        await this._writeCache(filePath, sha, parsed);
        return parsed;
      } catch (e) {
        console.warn('[zeus] enrich failed', filePath, e.message);
        // Cache the failure with explanation so SmartView shows it (avoids re-firing)
        const failReason = e.message.includes('context window')
          ? 'FoundationModels janela 4096 tokens insuficiente para esta nota + vault context. Tente sub-folder menor ou nota mais curta.'
          : 'metafm enrich falhou: ' + e.message.slice(0, 200);
        const result = { suggested_links: [], suggested_tags: [], connections: [], skipped: true, reason: failReason };
        await this._writeCache(filePath, sha, result);
        return result;
      } finally {
        this.inFlight.delete(filePath);
      }
    })();
    this.inFlight.set(filePath, promise);
    return promise;
  }
}

// =========================================================================
// Vault Agent — `metafm agent` for vault Q&A
// =========================================================================

class ZeusVaultAgent {
  constructor(plugin) {
    this.plugin = plugin;
  }

  async ask(question, onProgress) {
    // ADR-018 fase E++: agent agora roteia HTTP-first (funciona em iOS)
    const args = [
      'agent', question,
      '--vault', this.plugin.vaultRoot,
      '--pattern', this.plugin.settings.agentPattern,
      '--max-iterations', String(this.plugin.settings.agentMaxIterations),
      '--prewarm',
    ];
    if (onProgress) onProgress('FoundationModels processando (pode levar 30-60s)…');
    const r = await tryDaemonOrSpawn(
      this.plugin,
      'agent',
      [question, this.plugin.settings.agentPattern],
      args,
      null,
      180000
    );
    if (r.source === 'daemon') {
      const v = r.result;
      // Daemon may return { answer, text, output }; pick whichever
      return String((v && (v.answer || v.text || v.output || v.response)) || JSON.stringify(v));
    }
    return r.result;
  }
}

// =========================================================================
// UI — Ask Vault Modal
// =========================================================================

class ZeusAskVaultModal extends obsidian.Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('zeus-ask-modal');
    contentEl.createEl('h3', { text: 'Pergunte ao vault' });
    contentEl.createEl('p', { text: 'FoundationModels lê notas via tool-calling e responde. Reasoning on-device, sem rede.', cls: 'zeus-ask-hint' });

    const input = contentEl.createEl('textarea', { cls: 'zeus-ask-input' });
    input.rows = 3;
    input.placeholder = 'Ex: Quais notas tratam de Aegis e qual a sua relação com Tailscale?';

    const status = contentEl.createDiv({ cls: 'zeus-ask-status' });
    const answer = contentEl.createDiv({ cls: 'zeus-ask-answer' });

    const submit = contentEl.createEl('button', { text: 'Perguntar', cls: 'mod-cta zeus-ask-submit' });
    submit.onclick = async () => {
      const q = input.value.trim();
      if (!q) return;
      submit.disabled = true;
      answer.empty();
      status.setText('FoundationModels processando…');
      try {
        const out = await this.plugin.agent.ask(q, msg => status.setText(msg));
        status.setText('');
        answer.createEl('div', { cls: 'zeus-ask-answer-text', text: out });
      } catch (e) {
        status.setText('Erro: ' + e.message.slice(0, 200));
      } finally {
        submit.disabled = false;
      }
    };
    input.focus();
  }

  onClose() { this.contentEl.empty(); }
}

// =========================================================================
// UI — Passport Find Modal (v0.9 — PIA: MCP-first agent surface)
// =========================================================================

class ZeusPassportFindModal extends obsidian.Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('zeus-passport-find-modal');
    contentEl.createEl('h3', { text: 'Passport Find — busca por conceitos (PIA)' });
    contentEl.createEl('p', {
      text: 'Retorna passports (concepts + summary + domain + difficulty) sem conteúdo bruto — token-eficiente.',
      cls: 'zeus-ask-hint',
    });

    const input = contentEl.createEl('input', { cls: 'zeus-passport-find-input', type: 'text' });
    input.placeholder = 'Query: ex. arquitetura Aegis com Tailscale';

    const status = contentEl.createDiv({ cls: 'zeus-ask-status' });
    const results = contentEl.createDiv({ cls: 'zeus-passport-find-results' });

    const submit = contentEl.createEl('button', { text: 'Buscar passports', cls: 'mod-cta' });
    submit.onclick = async () => {
      const q = input.value.trim();
      if (!q) return;
      submit.disabled = true;
      results.empty();
      status.setText('Buscando passports…');
      try {
        const hits = await this.plugin.passport.findByQuery(q, { topN: 10 });
        status.setText(`${hits.length} resultado(s)`);
        for (const p of hits) {
          const card = results.createDiv({ cls: 'zeus-passport-card' });
          const title = card.createEl('div', { cls: 'zeus-passport-card-title', text: p.path });
          title.style.fontWeight = 'bold';
          title.style.cursor = 'pointer';
          title.onclick = () => {
            this.app.workspace.openLinkText(p.path, '', false);
            this.close();
          };
          if (p.one_line_summary) {
            card.createEl('div', { cls: 'zeus-passport-card-summary', text: p.one_line_summary });
          }
          const meta = card.createEl('div', { cls: 'zeus-passport-card-meta' });
          if (p.concepts && p.concepts.length) {
            meta.createEl('span', { text: 'concepts: ' + p.concepts.slice(0, 6).join(', ') });
          }
          if (p.domain && p.domain.length) {
            meta.createEl('span', { text: ' | domain: ' + p.domain.join(', ') });
          }
          if (p.difficulty != null) {
            meta.createEl('span', { text: ' | difficulty: ' + p.difficulty });
          }
        }
        if (!hits.length) {
          results.createDiv({ text: 'Nenhum passport encontrado. Rode "zeus-passport-build-all" primeiro?' });
        }
      } catch (e) {
        status.setText('Erro: ' + e.message.slice(0, 200));
      } finally {
        submit.disabled = false;
      }
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') submit.click(); });
    input.focus();
  }

  onClose() { this.contentEl.empty(); }
}

// =========================================================================
// UI — Search Modal
// =========================================================================

class ZeusSearchModal extends SuggestModal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder('Zeus — busca semântica Apple-native (cosine + exact boost)…');
    this.cachedResults = [];
    this.lastQuery = '';
    this.searchTimer = null;
  }

  async getSuggestions(query) {
    if (!query || query.length < 2) return [];
    if (query === this.lastQuery) return this.cachedResults;
    this.lastQuery = query;
    try {
      const results = await this.plugin.searcher.search(query, this.plugin.settings.maxResults);
      this.cachedResults = results;
      return results;
    } catch (e) {
      console.warn('[zeus] search failed', e.message);
      return [];
    }
  }

  renderSuggestion(result, el) {
    el.empty();
    el.addClass('zeus-result');
    const head = el.createDiv({ cls: 'zeus-result-head' });
    head.createSpan({ cls: 'zeus-result-title', text: result.path.replace(/\.md$/, '').split('/').pop() });
    const meta = head.createSpan({ cls: 'zeus-result-meta' });
    if (result.semantic > 0) meta.createSpan({ cls: 'zeus-badge zeus-badge-sem', text: (result.semantic * 100).toFixed(0) });
    if (result.exact > 0) meta.createSpan({ cls: 'zeus-badge zeus-badge-exact', text: 'EXACT' });
    el.createDiv({ cls: 'zeus-result-path', text: result.path });
    const excerpt = this.plugin.searcher.excerpt(result.path, this.lastQuery, this.plugin.settings.excerptLength);
    if (excerpt) el.createDiv({ cls: 'zeus-result-excerpt', text: excerpt });
  }

  async onChooseSuggestion(result) {
    const file = this.app.vault.getAbstractFileByPath(result.path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf().openFile(file);
    }
  }
}

// =========================================================================
// UI — Smart View (right sidebar pane)
// =========================================================================

class ZeusSmartView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
  }
  getViewType() { return VIEW_TYPE_SMART; }
  getDisplayText() { return 'Zeus — Conexões'; }
  getIcon() { return 'sparkles'; }

  async onOpen() {
    this.containerEl.children[1].empty();
    this.containerEl.children[1].addClass('zeus-smart-view');
    this.registerEvent(this.app.workspace.on('file-open', () => this.refresh()));
    this.refresh();
  }

  /**
   * v0.13 — Mini-graph SVG showing active note (center) + cosine neighbors (orbiting).
   * Smart Connections-style: nodes positioned by score (higher = closer to center).
   * Scores shown as labels (0.86 format). Click node = open that note.
   */
  _renderMiniGraph(container, activeFile, neighbors) {
    const W = 320, H = 280;
    const cx = W / 2, cy = H / 2;
    const wrap = container.createDiv({ cls: 'zeus-smart-graph-wrap' });
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'zeus-smart-graph-svg');

    // Edges (active node to each neighbor)
    const positions = [];
    neighbors.forEach((n, i) => {
      const angle = (i / neighbors.length) * 2 * Math.PI - Math.PI / 2;
      // distance: higher score → closer (40-110 range based on score 1.0-0.5)
      const dist = 50 + (1 - Math.min(1, Math.max(0, n.score))) * 90;
      const x = cx + dist * Math.cos(angle);
      const y = cy + dist * Math.sin(angle);
      positions.push({ ...n, x, y });
    });

    // Draw edges first (so circles render on top)
    for (const p of positions) {
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', cx); line.setAttribute('y1', cy);
      line.setAttribute('x2', p.x); line.setAttribute('y2', p.y);
      line.setAttribute('class', 'zeus-smart-graph-edge');
      line.setAttribute('stroke-opacity', String(0.15 + p.score * 0.4));
      svg.appendChild(line);
    }

    // Score labels for each neighbor (positioned away from center)
    for (const p of positions) {
      const labelOffsetX = p.x < cx ? -10 : 10;
      const labelAnchor = p.x < cx ? 'end' : 'start';
      const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      label.setAttribute('x', p.x + labelOffsetX);
      label.setAttribute('y', p.y - 8);
      label.setAttribute('class', 'zeus-smart-graph-score');
      label.setAttribute('text-anchor', labelAnchor);
      label.textContent = p.score.toFixed(2);
      svg.appendChild(label);
    }

    // Active node — central, larger, purple/orange
    const activeCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    activeCircle.setAttribute('cx', cx); activeCircle.setAttribute('cy', cy);
    activeCircle.setAttribute('r', 8);
    activeCircle.setAttribute('class', 'zeus-smart-graph-node zeus-smart-graph-node-active');
    svg.appendChild(activeCircle);

    // Neighbor nodes
    for (const p of positions) {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      circle.setAttribute('cx', p.x); circle.setAttribute('cy', p.y);
      circle.setAttribute('r', 4);
      circle.setAttribute('class', 'zeus-smart-graph-node');
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      title.textContent = `${p.score.toFixed(2)} · ${p.path}`;
      circle.appendChild(title);
      circle.style.cursor = 'pointer';
      circle.addEventListener('click', async () => {
        const tf = this.app.vault.getAbstractFileByPath(p.path);
        if (tf instanceof TFile) await this.app.workspace.getLeaf().openFile(tf);
      });
      svg.appendChild(circle);
    }

    wrap.appendChild(svg);

    // Caption
    const caption = wrap.createDiv({ cls: 'zeus-smart-graph-caption' });
    caption.createSpan({ text: `${neighbors.length} vizinhos · ` });
    const fileName = activeFile.basename;
    caption.createSpan({ cls: 'zeus-smart-graph-caption-active', text: fileName });
  }

  async refresh() {
    const container = this.containerEl.children[1];
    container.empty();
    const file = this.app.workspace.getActiveFile();

    // =========== Header com título da nota ativa ===========
    const headerCosine = container.createDiv({ cls: 'zeus-smart-header' });
    headerCosine.createSpan({ cls: 'zeus-smart-title-active', text: file ? file.basename : 'Conexões' });

    if (!file) {
      container.createDiv({ cls: 'zeus-smart-empty', text: 'Abra uma nota para ver conexões.' });
      return;
    }

    const neighbors = this.plugin.searcher.neighbors(file.path, this.plugin.settings.smartNeighborsCount);
    if (neighbors.length === 0) {
      container.createDiv({ cls: 'zeus-smart-empty', text: 'Sem embeddings — execute "Reindex" via Cmd+P.' });
    } else {
      // v0.13 — Mini-graph SVG no topo (Smart Connections style)
      this._renderMiniGraph(container, file, neighbors);

      // Lista chevron-expandable abaixo (formato 0.86 › link)
      const list = container.createDiv({ cls: 'zeus-smart-list-chevron' });
      for (const n of neighbors) {
        const item = list.createDiv({ cls: 'zeus-smart-chevron-item' });
        const chevron = item.createSpan({ cls: 'zeus-smart-chevron', text: '›' });
        const scoreEl = item.createSpan({ cls: 'zeus-smart-chevron-score', text: n.score.toFixed(2) });
        item.createSpan({ cls: 'zeus-smart-chevron-sep', text: ' › ' });
        const link = item.createSpan({ cls: 'zeus-smart-chevron-link', text: n.path.replace(/\.md$/, '').split('/').pop() });

        let expanded = false;
        let expandPanel = null;
        const toggle = (e) => {
          e.stopPropagation();
          expanded = !expanded;
          chevron.setText(expanded ? '⌄' : '›');
          if (expanded) {
            expandPanel = item.createDiv({ cls: 'zeus-smart-chevron-detail' });
            expandPanel.createDiv({ cls: 'zeus-smart-chevron-path', text: n.path });
            try {
              const excerpt = this.plugin.searcher.excerpt(n.path, '', 180);
              if (excerpt) expandPanel.createDiv({ cls: 'zeus-smart-chevron-excerpt', text: excerpt });
            } catch (_) {}
          } else if (expandPanel) {
            expandPanel.remove();
            expandPanel = null;
          }
        };
        chevron.onclick = toggle;
        link.onclick = async (e) => {
          e.stopPropagation();
          const tf = this.app.vault.getAbstractFileByPath(n.path);
          if (tf instanceof TFile) await this.app.workspace.getLeaf().openFile(tf);
        };
      }
    }

    // =========== Layer 2: FoundationModels enrich (async) ===========
    // ADR-018 fase E++: enrich agora suporta iOS via daemon HTTP — gate só pelo setting.
    if (!this.plugin.settings.enrichOnOpen) return;
    const fmHeader = container.createDiv({ cls: 'zeus-smart-header zeus-smart-header-fm' });
    fmHeader.createSpan({ cls: 'zeus-smart-title', text: 'FoundationModels' });
    const fmBadge = fmHeader.createSpan({ cls: 'zeus-badge zeus-badge-fm', text: 'reasoning…' });
    const fmSection = container.createDiv({ cls: 'zeus-smart-fm-section' });

    // Debounce — quick file switches shouldn't fire enrich
    clearTimeout(this._enrichTimer);
    this._enrichTimer = setTimeout(async () => {
      const result = await this.plugin.enricher.enrichNote(file.path);
      if (!result) {
        fmBadge.setText('falhou');
        fmSection.createDiv({ cls: 'zeus-smart-empty', text: 'metafm enrich não retornou. Console: Cmd+Opt+I.' });
        return;
      }
      if (result.skipped) {
        fmBadge.setText('skip');
        fmSection.createDiv({ cls: 'zeus-smart-empty', text: result.reason || 'Pulado.' });
        return;
      }
      fmBadge.setText('cached');
      fmBadge.removeClass('zeus-badge-fm');
      fmBadge.addClass('zeus-badge-fm-ok');

      // suggested_links
      if (result.suggested_links && result.suggested_links.length > 0) {
        const sub = fmSection.createDiv({ cls: 'zeus-smart-subsection' });
        sub.createEl('div', { cls: 'zeus-smart-subtitle', text: 'Links sugeridos' });
        for (const link of result.suggested_links.slice(0, 8)) {
          const item = sub.createDiv({ cls: 'zeus-smart-item zeus-smart-item-fm' });
          const body = item.createDiv({ cls: 'zeus-smart-item-body' });
          body.createDiv({ cls: 'zeus-smart-item-title', text: link.title || link.path });
          if (link.reason) body.createDiv({ cls: 'zeus-smart-item-reason', text: link.reason });
          if (link.path) body.createDiv({ cls: 'zeus-smart-item-path', text: link.path });
          item.onclick = async () => {
            if (!link.path) return;
            const tf = this.app.vault.getAbstractFileByPath(link.path);
            if (tf instanceof TFile) await this.app.workspace.getLeaf().openFile(tf);
          };
        }
      }

      // connections (with explanations)
      if (result.connections && result.connections.length > 0) {
        const sub = fmSection.createDiv({ cls: 'zeus-smart-subsection' });
        sub.createEl('div', { cls: 'zeus-smart-subtitle', text: 'Conexões' });
        for (const c of result.connections.slice(0, 6)) {
          const item = sub.createDiv({ cls: 'zeus-smart-conn' });
          item.createDiv({ cls: 'zeus-smart-conn-title', text: c.target || c.title || '—' });
          if (c.explanation || c.reason) item.createDiv({ cls: 'zeus-smart-conn-reason', text: c.explanation || c.reason });
        }
      }

      // suggested_tags
      if (result.suggested_tags && result.suggested_tags.length > 0) {
        const sub = fmSection.createDiv({ cls: 'zeus-smart-subsection' });
        sub.createEl('div', { cls: 'zeus-smart-subtitle', text: 'Tags sugeridas' });
        const tagWrap = sub.createDiv({ cls: 'zeus-smart-tags' });
        for (const t of result.suggested_tags.slice(0, 12)) {
          const tag = typeof t === 'string' ? t : (t.tag || t.name || '');
          if (tag) tagWrap.createSpan({ cls: 'zeus-smart-tag', text: '#' + tag });
        }
      }
    }, this.plugin.settings.enrichDebounceMs);
  }
}

// =========================================================================
// UI — Status View (persistent calibration pane, Smart Connections-style)
// =========================================================================

class ZeusStatusView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.interval = null;
  }
  getViewType() { return VIEW_TYPE_STATUS; }
  getDisplayText() { return 'Zeus — Status'; }
  getIcon() { return 'activity'; }

  async onOpen() {
    this.containerEl.children[1].empty();
    this.containerEl.children[1].addClass('zeus-status-view');
    this.refresh();
    this.interval = setInterval(() => this.refresh(), 5000);   // refresh a cada 5s
  }
  async onClose() {
    if (this.interval) clearInterval(this.interval);
  }

  async refresh() {
    const container = this.containerEl.children[1];
    container.empty();

    const header = container.createDiv({ cls: 'zeus-status-header' });
    header.createEl('h3', { text: 'Zeus Engine' });

    // === Daemon section ===
    const daemonSection = container.createDiv({ cls: 'zeus-status-section' });
    daemonSection.createDiv({ cls: 'zeus-status-section-title', text: 'Daemon HTTP' });
    try {
      const health = await this.plugin.httpClient.health();
      const tools = await this.plugin.httpClient.tools();
      this._addStatusRow(daemonSection, 'URL', this.plugin.settings.zeusDaemonUrl);
      this._addStatusRow(daemonSection, 'Status', health.status || 'unreachable', health.status === 'ok' ? 'ok' : 'err');
      this._addStatusRow(daemonSection, 'Platform', health.platform || '?');
      this._addStatusRow(daemonSection, 'Endpoints', String((health.endpoints || []).length));
      this._addStatusRow(daemonSection, 'Tools', String(tools.length));
      this._addStatusRow(daemonSection, 'NLContextualEmbedding', health.nl_available ? '✓' : '✗', health.nl_available ? 'ok' : 'err');
      this._addStatusRow(daemonSection, 'Vision', health.vision_available ? '✓' : '✗', health.vision_available ? 'ok' : 'err');
      this._addStatusRow(daemonSection, 'FoundationModels', health.fm_available ? '✓' : '✗', health.fm_available ? 'ok' : 'warn');
      if (health.translation_available !== undefined) {
        this._addStatusRow(daemonSection, 'Translation', health.translation_available ? '✓' : '✗', health.translation_available ? 'ok' : 'warn');
      }
    } catch (e) {
      this._addStatusRow(daemonSection, 'Status', 'UNREACHABLE: ' + e.message.slice(0, 60), 'err');
    }

    // === Index section ===
    const indexSection = container.createDiv({ cls: 'zeus-status-section' });
    indexSection.createDiv({ cls: 'zeus-status-section-title', text: 'Indexação' });
    const manifest = this.plugin.indexer.loadManifest();
    const fileCount = Object.keys(manifest.files || {}).length;
    const embCount = this.plugin.searcher.embeddings.size;
    const lastIdx = manifest.indexedAt ? new Date(manifest.indexedAt).toLocaleString('pt-BR') : 'nunca';
    this._addStatusRow(indexSection, 'Total docs', String(fileCount));
    this._addStatusRow(indexSection, 'Embeddings cached', String(embCount));
    this._addStatusRow(indexSection, 'Model', manifest.model || 'apple-nlcontextual-pt-BR');
    this._addStatusRow(indexSection, 'Dim', String(manifest.dim || 512));
    this._addStatusRow(indexSection, 'Última indexação', lastIdx);
    this._addStatusRow(indexSection, 'Indexando agora', this.plugin.indexer.indexing ? '⚡ SIM' : 'não');

    // Calibration bar — % indexed
    const calib = container.createDiv({ cls: 'zeus-status-section' });
    calib.createDiv({ cls: 'zeus-status-section-title', text: 'Cobertura de embeddings' });
    const pct = fileCount > 0 ? Math.round((embCount / fileCount) * 100) : 0;
    const barWrap = calib.createDiv({ cls: 'zeus-progress-wrap' });
    const bar = barWrap.createDiv({ cls: 'zeus-progress-bar' });
    bar.style.width = pct + '%';
    bar.setText(pct + '%');

    // === Settings summary ===
    const settingsSection = container.createDiv({ cls: 'zeus-status-section' });
    settingsSection.createDiv({ cls: 'zeus-status-section-title', text: 'Modos ativos' });
    this._addStatusRow(settingsSection, 'HyDE', this.plugin.settings.hydeEnabled ? 'ON' : 'off');
    this._addStatusRow(settingsSection, 'Multi-vector', this.plugin.settings.multiVectorEnabled ? 'ON' : 'off');
    this._addStatusRow(settingsSection, 'Native graph', this.plugin.settings.nativeGraphIntegration ? 'ON' : 'off');
    this._addStatusRow(settingsSection, 'Auto-reindex', this.plugin.settings.indexOnSave ? 'ON' : 'off');
    this._addStatusRow(settingsSection, 'Image features', this.plugin.settings.avImageFeatures ? 'ON' : 'off');

    // === Actions ===
    const actions = container.createDiv({ cls: 'zeus-status-actions' });
    const reindexBtn = actions.createEl('button', { text: '⟳ Reindex', cls: 'mod-cta' });
    reindexBtn.onclick = async () => {
      reindexBtn.disabled = true;
      await this.plugin.indexer.runFullIndex(msg => this.plugin.updateStatusBar('indexing', msg));
      reindexBtn.disabled = false;
      this.refresh();
    };

    const probeBtn = actions.createEl('button', { text: '⚡ Probe daemon' });
    probeBtn.onclick = async () => this.refresh();
  }

  _addStatusRow(parent, label, value, status = null) {
    const row = parent.createDiv({ cls: 'zeus-status-row' });
    row.createSpan({ cls: 'zeus-status-label', text: label });
    const valEl = row.createSpan({ cls: 'zeus-status-value', text: String(value) });
    if (status === 'ok') valEl.addClass('zeus-status-ok');
    else if (status === 'err') valEl.addClass('zeus-status-err');
    else if (status === 'warn') valEl.addClass('zeus-status-warn');
  }
}

// =========================================================================
// Settings tab
// =========================================================================

class ZeusSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Zeus — Apple-native Search' });
    const desc = containerEl.createEl('p');
    desc.appendText('Substitui Omnisearch + Smart Connections com 100% Apple-native: ');
    desc.createEl('strong', { text: 'NLContextualEmbedding' });
    desc.appendText(' (on-device, 512-dim) para ranqueamento + ');
    desc.createEl('strong', { text: 'Vision OCR' });
    desc.appendText(' para PDFs/imagens. Sem BM25 próprio, sem tokenizer próprio, sem bge-micro-v2.');

    new Setting(containerEl)
      .setName('afm binary path')
      .setDesc(`Apple Foundation Models CLI. Vazio = auto (bundled bin/afm > ~/.local/bin/metafm > $PATH). Resolved: ${this.plugin.afmBin}`)
      .addText(t => t.setValue(this.plugin.settings.afmPath || '').setPlaceholder('auto-detect').onChange(async v => { this.plugin.settings.afmPath = v; await this.plugin.saveSettings(); this.plugin.afmBin = resolveAfmBinary(this.plugin); }));

    containerEl.createEl('h3', { text: 'Apple Vision multi-modal (av)' });

    new Setting(containerEl)
      .setName('Image features extraction')
      .setDesc('Para cada imagem indexada: aocr (texto) + av classify (categorias) + av landmarks (faces) + acs metadata (EXIF/GPS/data). Combinado é embeddado pelo afm.')
      .addToggle(t => t.setValue(this.plugin.settings.avImageFeatures).onChange(async v => { this.plugin.settings.avImageFeatures = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('av classify top-N')
      .setDesc('Quantas categorias visuais extrair por imagem (1-20).')
      .addSlider(s => s.setLimits(3, 20, 1).setValue(this.plugin.settings.avClassifyTopN).setDynamicTooltip().onChange(async v => { this.plugin.settings.avClassifyTopN = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('aocr PDF structured (macOS 26+)')
      .setDesc('Usa RecognizeDocumentsRequest layout-aware para PDFs. EXPERIMENTAL. Fallback automático para aocr regular.')
      .addToggle(t => t.setValue(this.plugin.settings.aocrPdfStructured).onChange(async v => { this.plugin.settings.aocrPdfStructured = v; await this.plugin.saveSettings(); }));

    containerEl.createEl('h3', { text: 'Aegis-pattern HTTP daemon (v0.6, ADR-018)' });

    new Setting(containerEl)
      .setName('Zeus daemon URL')
      .setDesc('Loopback local: http://127.0.0.1:2223 (mesma máquina). Cross-device via Tailscale: http://100.65.240.43:2223 (iPhone) ou http://100.91.107.120:2223 (iPad). Funciona idêntico em Mac/iOS via Obsidian requestUrl (bypass CORS). Daemon Swift fornece embed/enrich/agent/ocr/etc.')
      .addText(t => t.setValue(this.plugin.settings.zeusDaemonUrl).setPlaceholder('http://127.0.0.1:2223').onChange(async v => {
        this.plugin.settings.zeusDaemonUrl = v;
        await this.plugin.saveSettings();
        this.plugin.httpClient.setBaseUrl(v);
      }));

    new Setting(containerEl)
      .setName('Prefer daemon over child_process (EXPERIMENTAL)')
      .setDesc('Quando ON: hot path tenta HTTP daemon primeiro, fallback child_process se daemon indisponível. Requer daemon rodando no device. Em iOS, esta é a ÚNICA forma de embed/enrich novos (Capacitor bloqueia spawn). Default OFF até daemon estar deployado.')
      .addToggle(t => t.setValue(this.plugin.settings.daemonPreferredOverSpawn).onChange(async v => {
        this.plugin.settings.daemonPreferredOverSpawn = v;
        await this.plugin.saveSettings();
      }));

    containerEl.createEl('h3', { text: 'HyDE — Hypothetical Document Embedding (DISRUPTIVE)' });

    new Setting(containerEl)
      .setName('HyDE query expansion')
      .setDesc('Expande sua query em uma "nota hipotética" via afm prompt, depois embeda a nota expandida. Pattern de 2023 (Gao et al.) que bate vanilla query embedding em 10-20% nos benchmarks. Custo: +~3s por busca. Default OFF — habilite para queries complexas/abstratas.')
      .addToggle(t => t.setValue(this.plugin.settings.hydeEnabled).onChange(async v => { this.plugin.settings.hydeEnabled = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Embedding backend')
      .setDesc('apple = NLContextualEmbedding (Apple-native, 512-dim, rápido). e5 = multilingual-e5-small (Python, mais idiomas, requer apple-fm-sdk).')
      .addDropdown(d => d.addOption('apple', 'apple (NLContextualEmbedding)').addOption('e5', 'e5 (multilingual)').setValue(this.plugin.settings.embedBackend).onChange(async v => { this.plugin.settings.embedBackend = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Apple Vision OCR')
      .setDesc('Extrai texto de PDFs e imagens (on-device, sem rede).')
      .addToggle(t => t.setValue(this.plugin.settings.ocrEnabled).onChange(async v => { this.plugin.settings.ocrEnabled = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Exact-match boost')
      .setDesc('Boost quando a query aparece literalmente no título/conteúdo. 0 = puro semântico; 1 = match exato dobra score.')
      .addSlider(s => s.setLimits(0, 1, 0.05).setValue(this.plugin.settings.exactMatchBoost).setDynamicTooltip().onChange(async v => { this.plugin.settings.exactMatchBoost = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Smart neighbors count')
      .setDesc('Quantas notas semelhantes mostrar no painel lateral.')
      .addSlider(s => s.setLimits(3, 30, 1).setValue(this.plugin.settings.smartNeighborsCount).setDynamicTooltip().onChange(async v => { this.plugin.settings.smartNeighborsCount = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Auto-reindex on save')
      .setDesc('Recalcula índice 5s após cada modificação (Mac only).')
      .addToggle(t => t.setValue(this.plugin.settings.indexOnSave).onChange(async v => { this.plugin.settings.indexOnSave = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Reindex on startup')
      .setDesc('Reindex completo 3s após abrir Obsidian (Mac only).')
      .addToggle(t => t.setValue(this.plugin.settings.indexOnStartup).onChange(async v => { this.plugin.settings.indexOnStartup = v; await this.plugin.saveSettings(); }));

    containerEl.createEl('h3', { text: 'FoundationModels reasoning layer' });

    new Setting(containerEl)
      .setName('Enrich on note open (EXPERIMENTAL)')
      .setDesc('Roda `metafm enrich` na nota ativa: FoundationModels lê notas relacionadas via tool-calling e sugere links + conexões. LIMITAÇÃO: FoundationModels tem janela 4096 tokens — system prompt + tool descrições consomem ~1500, sobrando ~2500 para o conteúdo da nota + tool responses. Notas >~2KB ou vault com muitos folders pode estourar (skip silencioso). Default off; ligue se trabalhar com notas curtas. Cache por SHA.')
      .addToggle(t => t.setValue(this.plugin.settings.enrichOnOpen).onChange(async v => { this.plugin.settings.enrichOnOpen = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Agent pattern')
      .setDesc('Padrão de raciocínio para "Pergunte ao vault": auto (FM classifica), react (exploratório), plan-execute (estruturado), reflexion (auto-crítica iterativa).')
      .addDropdown(d => d
        .addOption('auto', 'auto')
        .addOption('react', 'react')
        .addOption('plan-execute', 'plan-execute')
        .addOption('reflexion', 'reflexion')
        .setValue(this.plugin.settings.agentPattern)
        .onChange(async v => { this.plugin.settings.agentPattern = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Agent max iterations (reflexion)')
      .setDesc('Limite de loops de auto-crítica para padrão reflexion.')
      .addSlider(s => s.setLimits(1, 10, 1).setValue(this.plugin.settings.agentMaxIterations).setDynamicTooltip().onChange(async v => { this.plugin.settings.agentMaxIterations = v; await this.plugin.saveSettings(); }));

    containerEl.createEl('h3', { text: 'v0.7 — full Apple ecosystem coverage' });

    new Setting(containerEl)
      .setName('Index image feature-prints (VNGenerateImageFeaturePrint)')
      .setDesc('Quando ON, comandos de indexação populam data/image-features.jsonl com vetor 768-dim por imagem. Habilita o comando "encontrar imagens similares à atual". Requer daemon Zeus rodando (Mac).')
      .addToggle(t => t.setValue(this.plugin.settings.imagesIndexFeaturePrint).onChange(async v => { this.plugin.settings.imagesIndexFeaturePrint = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Auto language-detect on save')
      .setDesc('Detecta língua dominante (NLLanguageRecognizer) ao salvar e adiciona `lang:` ao frontmatter caso ausente. EXPERIMENTAL — pode modificar notas.')
      .addToggle(t => t.setValue(this.plugin.settings.autoLanguageDetectOnSave).onChange(async v => { this.plugin.settings.autoLanguageDetectOnSave = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Spotlight query enabled (CSSearchQuery bridge)')
      .setDesc('Permite o comando "Zeus: buscar via Spotlight nativo" consultar o índice macOS via CSSearchQuery exposto pelo daemon. Funciona apenas no Mac.')
      .addToggle(t => t.setValue(this.plugin.settings.spotlightQueryEnabled).onChange(async v => { this.plugin.settings.spotlightQueryEnabled = v; await this.plugin.saveSettings(); }));

    containerEl.createEl('h3', { text: 'v0.8 — Native Obsidian Graph integration' });

    new Setting(containerEl)
      .setName('Native graph integration (DESTRUTIVO — opt-in)')
      .setDesc('Quando ON, comandos de sync escrevem `zeus_related:` no frontmatter de TODAS as notas com os top-N vizinhos semânticos (cosine). Obsidian Graph nativo (Cmd+G) renderiza esses como edges junto com wikilinks normais. AVISO: modifica frontmatter de todo o vault — use clear-all para reverter.')
      .addToggle(t => t.setValue(this.plugin.settings.nativeGraphIntegration).onChange(async v => { this.plugin.settings.nativeGraphIntegration = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Top-N vizinhos por nota')
      .setDesc('Quantos vizinhos semânticos escrever em `zeus_related:` (1-10).')
      .addSlider(s => s.setLimits(1, 10, 1).setValue(this.plugin.settings.nativeGraphTopN).setDynamicTooltip().onChange(async v => { this.plugin.settings.nativeGraphTopN = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Score mínimo de cosine')
      .setDesc('Edges abaixo deste score são filtrados. Mais alto = grafo mais esparso e relevante.')
      .addSlider(s => s.setLimits(0, 1, 0.05).setValue(this.plugin.settings.nativeGraphMinScore).setDynamicTooltip().onChange(async v => { this.plugin.settings.nativeGraphMinScore = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName('Auto-resync on save')
      .setDesc('Re-sincroniza `zeus_related:` 6s após cada modificação da nota (independente de Mac/indexOnSave).')
      .addToggle(t => t.setValue(this.plugin.settings.nativeGraphSyncOnSave).onChange(async v => { this.plugin.settings.nativeGraphSyncOnSave = v; await this.plugin.saveSettings(); }));

    containerEl.createEl('h3', { text: 'Cross-device coordination (v0.10)' });

    new Setting(containerEl)
      .setName('Device ID')
      .setDesc('Identificador estável deste device (gerado uma vez, persistido). Usado em claim/release locks para evitar dupla extração quando o vault é sincronizado via iCloud.')
      .addText(t => {
        t.setValue(this.plugin.settings.deviceId || (this.plugin.coordinator && this.plugin.coordinator.deviceId) || '');
        t.setDisabled(true);
        return t;
      });

    new Setting(containerEl)
      .setName('Scheduler enabled (background sweep)')
      .setDesc('Quando ON, varre o vault periodicamente e re-extrai passports de notas cujo SHA mudou. Coordena claim/release com outros devices via locks em data/claims/. Hook on-modify também usa o coordinator para re-extract pontual.')
      .addToggle(t => t.setValue(this.plugin.settings.schedulerEnabled).onChange(async v => {
        this.plugin.settings.schedulerEnabled = v;
        await this.plugin.saveSettings();
        if (this.plugin.scheduler) {
          if (v) this.plugin.scheduler.start();
          else this.plugin.scheduler.stop();
        }
      }));

    new Setting(containerEl)
      .setName('Scheduler interval (minutes)')
      .setDesc('Intervalo entre varreduras automáticas (5 min - 60 min). Toggle o scheduler off+on para aplicar mudança.')
      .addSlider(s => s.setLimits(5, 60, 1).setValue(Math.round((this.plugin.settings.schedulerIntervalMs || (15 * 60 * 1000)) / 60000)).setDynamicTooltip().onChange(async v => {
        this.plugin.settings.schedulerIntervalMs = v * 60 * 1000;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Claim TTL (seconds)')
      .setDesc('Tempo até um lock expirar e ser auto-liberado. Default 60s — iCloud sync delay (5-30s) << TTL. Aumente se rede iCloud estiver lenta.')
      .addSlider(s => s.setLimits(30, 300, 10).setValue(Math.round((this.plugin.settings.coordTtlMs || 60000) / 1000)).setDynamicTooltip().onChange(async v => {
        this.plugin.settings.coordTtlMs = v * 1000;
        await this.plugin.saveSettings();
        if (this.plugin.coordinator) this.plugin.coordinator.ttlMs = v * 1000;
      }));

    new Setting(containerEl)
      .setName('Coordination stats')
      .setDesc('Snapshot dos claims ativos no momento.')
      .addButton(b => b.setButtonText('Stats').onClick(async () => {
        if (!this.plugin.scheduler) { new Notice('Zeus: scheduler indisponível'); return; }
        const s = await this.plugin.scheduler.stats();
        const c = s.coordinator || {};
        new Notice(
          `Zeus coord: ${c.total || 0} claims (${c.expired || 0} expired)\n` +
          `Device: ${c.thisDeviceId}\n` +
          `Scheduler: enabled=${s.enabled}, running=${s.running}`,
          8000,
        );
        console.log('[zeus] coordination stats', s);
      }));

    containerEl.createEl('h3', { text: 'Ações' });
    new Setting(containerEl)
      .setName('Reindex completo')
      .setDesc('Re-lê o vault e recalcula embeddings. Mac only — outros devices apenas lêem.')
      .addButton(b => b.setButtonText('Reindex').onClick(async () => {
        if (!isMac()) { new Notice('Reindex só funciona no Mac'); return; }
        const notice = new Notice('Zeus: reindex…', 0);
        await this.plugin.indexer.runFullIndex(msg => notice.setMessage('Zeus: ' + msg));
        notice.hide();
      }));

    new Setting(containerEl)
      .setName('Status do índice')
      .addButton(b => b.setButtonText('Status').onClick(() => {
        const m = this.plugin.indexer.loadManifest();
        const count = Object.keys(m.files || {}).length;
        const ts = m.indexedAt ? new Date(m.indexedAt).toLocaleString() : 'nunca';
        const emb = this.plugin.searcher.embeddings.size;
        new Notice(`Zeus: ${count} docs · ${emb} embeddings · model ${m.model || '?'} · ${ts}`);
      }));
  }
}

// =========================================================================
// Plugin entry
// =========================================================================

class ZeusPlugin extends Plugin {
  async onload() {
    // v0.11.2 — Master try/catch with on-disk trace para debug load failure
    const traceLog = [];
    const trace = (step, info) => {
      const line = `[${new Date().toISOString()}] ${step}${info ? ': ' + JSON.stringify(info).slice(0, 200) : ''}`;
      traceLog.push(line);
      console.log('[zeus.trace]', line);
    };
    const writeTrace = (err) => {
      try {
        if (fs && path && this.app.vault.adapter.basePath) {
          const tracePath = path.join(this.app.vault.adapter.basePath, this.manifest.dir, 'data', 'load-trace.log');
          fs.mkdirSync(path.dirname(tracePath), { recursive: true });
          fs.writeFileSync(tracePath, traceLog.join('\n') + (err ? '\n\n=== ERROR ===\n' + err.stack : ''));
        }
      } catch (_) {}
    };
    try {
      trace('start', { manifest: this.manifest.id, version: this.manifest.version });
      trace('loadData.begin');
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    trace('loadData.done');
    // vaultRoot is absolute path on Mac (Electron). On iOS Capacitor the adapter
    // exposes only relative paths — vaultRoot is undefined, callers must use
    // vault.adapter.* with vault-relative paths.
    this.vaultRoot = this.app.vault.adapter && this.app.vault.adapter.basePath ? this.app.vault.adapter.basePath : null;
    this._manifestCache = null;
    this._embeddingsCache = null;
    this.afmBin = resolveAfmBinary(this);
    console.log('[zeus] platform:', universal.detectPlatform(), '| afm binary:', this.afmBin, '| vaultRoot:', this.vaultRoot || '(adapter-only)');
    this.indexer = new ZeusIndexer(this);
    this.searcher = new ZeusSearcher(this);
    this.enricher = new ZeusEnricher(this);
    this.agent = new ZeusVaultAgent(this);
    this.av = new AppleVisionIntelligence(this);
    this.hyde = new HyDEExpander(this);
    this.graphExtractor = new ZeusGraphExtractor(this);
    this.nativeGraph = new ZeusNativeGraphIntegration(this);

    // v0.5.0 — modular extensions
    // pluginDataPath: absolute on Mac, vault-relative on iOS (multi-vector saveAll
    // is Mac-only anyway — gated by isMac() before invocation).
    const pluginDataPath = (path && this.vaultRoot)
      ? path.join(this.vaultRoot, this.manifest.dir, DATA_DIR_NAME)
      : universal.joinPath(this.manifest.dir, DATA_DIR_NAME);
    if (isMac() && this.settings.afmDaemonEnabled) {
      try {
        this.afmDaemon = new AfmDaemon(this.afmBin);
        this.afmDaemon.start().catch(e => console.warn('[zeus] afm-daemon start failed:', e.message));
      } catch (e) {
        console.warn('[zeus] afm-daemon construction skipped:', e.message);
      }
    }
    this.hierarchical = new HierarchicalProcessor(this.afmBin, this.settings.hierarchicalThreshold);
    this.multiVector = new MultiVectorEmbedder(this.afmBin, pluginDataPath);
    // v0.6.0 — ADR-018 Aegis-pattern HTTP daemon client (works on ALL devices: Mac+iOS uniform)
    this.httpClient = new ZeusHttpClient(this.settings.zeusDaemonUrl);
    // v0.7.0 — image similarity search via feature-print cache
    this.imageSimilarity = new ImageSimilaritySearch(this);
    // v0.9.0 — Passport Index Architecture (PIA): MCP-first agent surface
    this.passport = new PassportIndex(this);
    this.basesGen = new BasesGenerator(this);

    // v0.10.0 — Cross-device coordination (claim/release via iCloud-synced locks)
    this.coordinator = new DistributedCoordinator(this, {
      deviceId: this.settings.deviceId || undefined,
      ttlMs: this.settings.coordTtlMs || 60_000,
    });
    if (!this.settings.deviceId) {
      this.settings.deviceId = this.coordinator.deviceId;
      await this.saveSettings();
      console.log('[zeus] generated deviceId:', this.coordinator.deviceId);
    }
    // v0.10.0 — Background scheduler for stale-passport detection + claim-coordinated re-extract
    this.scheduler = new PassportScheduler(this, {
      intervalMs: this.settings.schedulerIntervalMs || 15 * 60 * 1000,
    });
    if (this.settings.schedulerEnabled) {
      this.scheduler.start();
    }

    // v0.6.1 — Adaptive daemon discovery (async, doesn't block onload)
    this.app.workspace.onLayoutReady(async () => {
      try {
        const discovered = await discoverDaemonUrl(this);
        if (discovered !== this.settings.zeusDaemonUrl) {
          console.log('[zeus] adapting daemon URL from', this.settings.zeusDaemonUrl, 'to', discovered);
          this.httpClient.setBaseUrl(discovered);
        }
        // Probe daemon capabilities to log what's available
        const health = await this.httpClient.health();
        const tools = await this.httpClient.tools();
        console.log('[zeus] daemon health:', health.status, '| platform:', health.platform, '| endpoints:', (health.endpoints || []).length, '| tools:', tools.length);
        if (health.status === 'ok') {
          new Notice(`Zeus: daemon ${health.platform || '?'} OK · ${(health.endpoints || []).length} endpoints`);
        }
      } catch (e) {
        console.warn('[zeus] adaptive discovery skipped:', e.message);
      }
    });

    this.loadIndices();
    // v0.11 — also kick off async preload so iOS gets manifest + embeddings
    // populated via vault.adapter (sync fs not available there).
    this.loadIndicesAsync().catch(e => console.warn('[zeus] async preload failed:', e.message));

    this.addSettingTab(new ZeusSettingTab(this.app, this));

    this.addCommand({
      id: 'zeus-search',
      name: 'Zeus: buscar (Apple NLContextualEmbedding)',
      callback: () => new ZeusSearchModal(this.app, this).open(),
    });
    this.addCommand({
      id: 'zeus-reindex',
      name: 'Zeus: reindexar vault completo',
      callback: async () => {
        if (!isMac()) { new Notice('Zeus reindex: só Mac'); return; }
        const n = new Notice('Zeus: reindex…', 0);
        await this.indexer.runFullIndex(m => {
          n.setMessage('Zeus: ' + m);
          this.updateStatusBar('indexing', m);
        });
        n.hide();
        this.updateStatusBar('idle', null);
      },
    });
    this.addCommand({
      id: 'zeus-toggle-smart-view',
      name: 'Zeus: abrir painel de conexões',
      callback: () => this.activateSmartView(),
    });
    this.addCommand({
      id: 'zeus-open-status',
      name: 'Zeus: abrir painel de status (calibração)',
      callback: () => this.activateStatusView(),
    });
    this.addCommand({
      id: 'zeus-ask-vault',
      name: 'Zeus: perguntar ao vault (FoundationModels agent)',
      callback: () => new ZeusAskVaultModal(this.app, this).open(),
    });
    this.addCommand({
      id: 'zeus-enrich-current',
      name: 'Zeus: enrich nota atual (FoundationModels)',
      callback: async () => {
        const f = this.app.workspace.getActiveFile();
        if (!f) { new Notice('Sem nota ativa'); return; }
        const n = new Notice('Zeus enrich: FoundationModels processando…', 0);
        const result = await this.enricher.enrichNote(f.path);
        n.hide();
        if (result) new Notice(`Zeus enrich: ${(result.suggested_links || []).length} links, ${(result.connections || []).length} conexões.`);
        else new Notice('Zeus enrich falhou — veja Console.');
        this.refreshSmartView();
      },
    });
    this.addCommand({
      id: 'zeus-graph-current',
      name: 'Zeus: knowledge graph da nota atual (FoundationModels)',
      callback: () => {
        const f = this.app.workspace.getActiveFile();
        if (!f) { new Notice('Sem nota ativa'); return; }
        new ZeusGraphModal(this.app, this, f.path).open();
      },
    });
    this.addCommand({
      id: 'zeus-toggle-hyde',
      name: 'Zeus: alternar HyDE query expansion',
      callback: async () => {
        this.settings.hydeEnabled = !this.settings.hydeEnabled;
        await this.saveSettings();
        new Notice(`Zeus HyDE: ${this.settings.hydeEnabled ? 'ON' : 'OFF'}`);
      },
    });
    this.addCommand({
      id: 'zeus-multi-vector-reindex',
      name: 'Zeus: reindexar com multi-vector (1536-dim efetivo)',
      callback: async () => {
        if (!isMac()) { new Notice('Multi-vector reindex: só Mac'); return; }
        const n = new Notice('Zeus multi-vector: lendo vault…', 0);
        try {
          const files = this.indexer.enumerateFiles().filter(f => f.ext === 'md');
          const docs = files.map(f => {
            const content = fs.readFileSync(f.abs, 'utf8');
            const title = f.rel.replace(/\.[^.]+$/, '').split('/').pop();
            const body = content.replace(/^---\n[\s\S]*?\n---\n/, '').slice(0, 4000);
            return { path: f.rel, title, body };
          });
          n.setMessage(`Zeus multi-vector: embeddando ${docs.length} docs (3 vetores cada)…`);
          const map = await this.multiVector.embedDocsBatch(docs);
          this.multiVector.saveAll(map);
          this.settings.multiVectorEnabled = true;
          await this.saveSettings();
          n.hide();
          new Notice(`Zeus multi-vector: ${map.size} docs com 3 vetores cada → data/multi-vectors.jsonl`);
        } catch (e) {
          n.hide();
          new Notice('Multi-vector falhou: ' + e.message.slice(0, 200));
        }
      },
    });
    this.addCommand({
      id: 'zeus-daemon-status',
      name: 'Zeus: status do afm daemon (Fix 1)',
      callback: () => {
        if (!this.afmDaemon) {
          new Notice('AfmDaemon não instanciado (Mac only ou setting OFF)');
          return;
        }
        const alive = this.afmDaemon.isAlive();
        const tools = (this.afmDaemon.tools || []).length;
        new Notice(`afm daemon: ${alive ? 'ALIVE' : 'DEAD'} · ${tools} tools discovered`);
      },
    });
    this.addCommand({
      id: 'zeus-http-daemon-probe',
      name: 'Zeus: probe HTTP daemon (Aegis-pattern, ADR-018)',
      callback: async () => {
        const n = new Notice(`Probing ${this.settings.zeusDaemonUrl}…`, 0);
        try {
          const health = await this.httpClient.health();
          const tools = await this.httpClient.tools();
          n.hide();
          new Notice(`Daemon: ${health.status || 'unknown'} · platform: ${health.platform || '?'} · ${tools.length} tools`);
          console.log('[zeus] HTTP daemon health:', health, 'tools:', tools);
        } catch (e) {
          n.hide();
          new Notice(`Daemon unreachable: ${e.message.slice(0, 200)}`);
        }
      },
    });

    // =====================================================================
    // v0.7.0 — full Apple ecosystem coverage commands
    // =====================================================================

    this.addCommand({
      id: 'zeus-translate-selection',
      name: 'Zeus: traduzir seleção (Apple Translation pt→en)',
      editorCallback: async (editor) => {
        const sel = editor.getSelection() || editor.getValue();
        if (!sel || !sel.trim()) { new Notice('Sem texto selecionado'); return; }
        const n = new Notice('Traduzindo via Apple Translation…', 0);
        try {
          const r = await this.httpClient.translate(sel, 'pt', 'en');
          n.hide();
          const out = (r && (r.translated || r.output || r.translation)) || JSON.stringify(r);
          try { await navigator.clipboard.writeText(out); } catch {}
          new Notice('Tradução copiada para clipboard');
          console.log('[zeus] translate:', out);
        } catch (e) {
          n.hide();
          new Notice('Translate falhou: ' + e.message.slice(0, 150));
        }
      },
    });

    this.addCommand({
      id: 'zeus-nl-sentiment',
      name: 'Zeus: análise de sentimento (NLTagger)',
      editorCallback: async (editor) => {
        const sel = editor.getSelection() || editor.getValue();
        if (!sel || !sel.trim()) { new Notice('Sem texto'); return; }
        const n = new Notice('Computando sentimento…', 0);
        try {
          const r = await this.httpClient.nlSentiment(sel);
          n.hide();
          const score = (r && (r.sentiment ?? r.score)) ?? 'n/a';
          new Notice(`Sentimento: ${typeof score === 'number' ? score.toFixed(3) : score}`);
          console.log('[zeus] sentiment:', r);
        } catch (e) {
          n.hide();
          new Notice('Sentiment falhou: ' + e.message.slice(0, 150));
        }
      },
    });

    this.addCommand({
      id: 'zeus-nl-language-detect',
      name: 'Zeus: detectar língua da nota (NLLanguageRecognizer)',
      callback: async () => {
        const f = this.app.workspace.getActiveFile();
        if (!f) { new Notice('Sem nota ativa'); return; }
        const n = new Notice('Detectando língua…', 0);
        try {
          const content = await this.app.vault.read(f);
          const sample = content.replace(/^---\n[\s\S]*?\n---\n/, '').slice(0, 4000);
          const r = await this.httpClient.nlLanguageDetect(sample, 3);
          n.hide();
          const dominant = (r && (r.dominant || r.language)) || '?';
          const hyps = (r && (r.hypotheses || r.candidates)) || [];
          const detail = hyps.length
            ? hyps.map(h => `${h.language || h.code}=${typeof h.confidence === 'number' ? h.confidence.toFixed(2) : h.confidence}`).join(', ')
            : '';
          new Notice(`Língua: ${dominant}${detail ? ' (' + detail + ')' : ''}`);
          console.log('[zeus] language-detect:', r);
        } catch (e) {
          n.hide();
          new Notice('Language-detect falhou: ' + e.message.slice(0, 150));
        }
      },
    });

    this.addCommand({
      id: 'zeus-nl-lemma',
      name: 'Zeus: lematizar nota (NLTagger lemma scheme)',
      callback: async () => {
        const f = this.app.workspace.getActiveFile();
        if (!f) { new Notice('Sem nota ativa'); return; }
        const n = new Notice('Lematizando…', 0);
        try {
          const content = await this.app.vault.read(f);
          const sample = content.replace(/^---\n[\s\S]*?\n---\n/, '').slice(0, 8000);
          const r = await this.httpClient.nlTag(sample, 'lemma');
          n.hide();
          const tags = (r && (r.tags || r.tokens)) || [];
          const preview = Array.isArray(tags) ? tags.slice(0, 20).map(t => (t.lemma || t.tag || t.token)).join(' ') : JSON.stringify(r).slice(0, 200);
          try { await navigator.clipboard.writeText(JSON.stringify(r, null, 2)); } catch {}
          new Notice(`Lemma: ${tags.length || '?'} tokens (preview no console; JSON no clipboard)`);
          console.log('[zeus] lemma preview:', preview, 'full:', r);
        } catch (e) {
          n.hide();
          new Notice('Lemma falhou: ' + e.message.slice(0, 150));
        }
      },
    });

    this.addCommand({
      id: 'zeus-data-detect',
      name: 'Zeus: detectar entidades (URLs/telefones/datas via NSDataDetector)',
      editorCallback: async (editor) => {
        const sel = editor.getSelection() || editor.getValue();
        if (!sel || !sel.trim()) { new Notice('Sem texto'); return; }
        const n = new Notice('NSDataDetector…', 0);
        try {
          const r = await this.httpClient.dataDetect(sel);
          n.hide();
          const matches = (r && (r.matches || r.entities)) || [];
          const counts = {};
          for (const m of matches) { counts[m.type || 'unknown'] = (counts[m.type || 'unknown'] || 0) + 1; }
          const summary = Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(' · ');
          try { await navigator.clipboard.writeText(JSON.stringify(matches, null, 2)); } catch {}
          new Notice(`Detectados: ${matches.length} (${summary || 'nenhum'}) — JSON no clipboard`);
          console.log('[zeus] data-detect:', r);
        } catch (e) {
          n.hide();
          new Notice('Data-detect falhou: ' + e.message.slice(0, 150));
        }
      },
    });

    this.addCommand({
      id: 'zeus-vision-document-scan',
      name: 'Zeus: scan de documento (VNRecognizeDocumentsRequest, layout-aware)',
      callback: async () => {
        const f = this.app.workspace.getActiveFile();
        let imagePath = null;
        if (f && /\.(png|jpe?g|heic|pdf|tiff|gif|webp|bmp)$/i.test(f.path)) {
          imagePath = (path && this.vaultRoot) ? path.join(this.vaultRoot, f.path) : f.path;
        } else {
          const input = await this._zeusPromptText('Caminho absoluto da imagem/PDF para scan estruturado:');
          if (!input) return;
          imagePath = input;
        }
        const n = new Notice('Vision document scan…', 0);
        try {
          const r = await this.httpClient.visionDocument(imagePath);
          n.hide();
          const text = (r && (r.text || r.markdown || r.content)) || '';
          const blocks = (r && (r.blocks || r.regions)) || [];
          try { await navigator.clipboard.writeText(text || JSON.stringify(r, null, 2)); } catch {}
          new Notice(`Document scan: ${blocks.length || 0} blocos · ${text.length} chars no clipboard`);
          console.log('[zeus] vision-document:', r);
        } catch (e) {
          n.hide();
          new Notice('Document scan falhou: ' + e.message.slice(0, 150));
        }
      },
    });

    this.addCommand({
      id: 'zeus-vision-aesthetics',
      name: 'Zeus: aesthetics score da imagem atual (VNCalculateImageAestheticsScores)',
      callback: async () => {
        const f = this.app.workspace.getActiveFile();
        let imagePath = null;
        if (f && /\.(png|jpe?g|heic|tiff|gif|webp|bmp)$/i.test(f.path)) {
          imagePath = (path && this.vaultRoot) ? path.join(this.vaultRoot, f.path) : f.path;
        } else {
          const input = await this._zeusPromptText('Caminho absoluto da imagem para avaliar:');
          if (!input) return;
          imagePath = input;
        }
        const n = new Notice('Aesthetics scoring…', 0);
        try {
          const r = await this.httpClient.visionAesthetics(imagePath);
          n.hide();
          const overall = (r && (r.overall_score ?? r.score ?? r.aesthetics)) ?? '?';
          const utility = (r && (r.is_utility ?? r.utility)) ?? '?';
          new Notice(`Aesthetics: ${typeof overall === 'number' ? overall.toFixed(3) : overall} · utility: ${utility}`);
          console.log('[zeus] aesthetics:', r);
        } catch (e) {
          n.hide();
          new Notice('Aesthetics falhou: ' + e.message.slice(0, 150));
        }
      },
    });

    this.addCommand({
      id: 'zeus-spotlight-search',
      name: 'Zeus: buscar via Spotlight nativo (CSSearchQuery)',
      callback: async () => {
        if (!this.settings.spotlightQueryEnabled) {
          new Notice('Spotlight query desabilitado — habilite em Settings → Zeus');
          return;
        }
        const query = await this._zeusPromptText('Query Spotlight:');
        if (!query || !query.trim()) return;
        const n = new Notice('Spotlight searching…', 0);
        try {
          const r = await this.httpClient.spotlightSearch(query, null, 50);
          n.hide();
          const results = (r && (r.results || r.matches || r.hits)) || [];
          try { await navigator.clipboard.writeText(JSON.stringify(results, null, 2)); } catch {}
          new Notice(`Spotlight: ${results.length} hits (JSON no clipboard)`);
          console.log('[zeus] spotlight:', r);
        } catch (e) {
          n.hide();
          new Notice('Spotlight falhou: ' + e.message.slice(0, 150));
        }
      },
    });

    this.addCommand({
      id: 'zeus-image-similarity-index',
      name: 'Zeus: indexar imagens do vault (feature-print 768-dim)',
      callback: async () => {
        if (!isMac()) { new Notice('Image-similarity index: só Mac'); return; }
        const n = new Notice('Zeus: feature-print indexer arrancando…', 0);
        try {
          this.imageSimilarity.loadCache();
          const stats = await this.imageSimilarity.indexAllImages(p => {
            n.setMessage(`Zeus img-sim: ${p.processed}/${p.total} (idx ${p.indexed}, skip ${p.skipped}, fail ${p.failed})`);
          });
          n.hide();
          new Notice(`Zeus img-sim: ${stats.indexed} novas · ${stats.skipped} cache · ${stats.failed} falhas / ${stats.total} imagens`);
          console.log('[zeus] image-similarity index stats:', stats);
        } catch (e) {
          n.hide();
          new Notice('Image-index falhou: ' + e.message.slice(0, 200));
        }
      },
    });

    this.addCommand({
      id: 'zeus-image-similarity-find',
      name: 'Zeus: encontrar imagens similares à atual (cosine sobre feature-print)',
      callback: async () => {
        if (!isMac()) { new Notice('Image-similarity: só Mac'); return; }
        const f = this.app.workspace.getActiveFile();
        let imagePath = null;
        if (f && /\.(png|jpe?g|heic|tiff|gif|webp|bmp)$/i.test(f.path)) {
          imagePath = (path && this.vaultRoot) ? path.join(this.vaultRoot, f.path) : f.path;
        } else {
          // try to find an embedded image reference in active note
          if (f) {
            try {
              const content = await this.app.vault.read(f);
              const m = content.match(/!\[\[([^\]|]+\.(?:png|jpe?g|heic|tiff|gif|webp|bmp))(?:\|[^\]]*)?\]\]/i)
                || content.match(/!\[[^\]]*\]\(([^)]+\.(?:png|jpe?g|heic|tiff|gif|webp|bmp))\)/i);
              if (m) {
                const ref = m[1];
                // try to resolve via metadataCache
                const tfile = this.app.metadataCache.getFirstLinkpathDest(ref, f.path);
                if (tfile) imagePath = (path && this.vaultRoot) ? path.join(this.vaultRoot, tfile.path) : tfile.path;
                else if (fs && path && fs.existsSync(path.join(this.vaultRoot, ref))) imagePath = path.join(this.vaultRoot, ref);
              }
            } catch {}
          }
          if (!imagePath) {
            const input = await this._zeusPromptText('Caminho absoluto da imagem alvo:');
            if (!input) return;
            imagePath = input;
          }
        }
        const n = new Notice('Procurando similares…', 0);
        try {
          this.imageSimilarity.loadCache();
          const matches = await this.imageSimilarity.findSimilar(imagePath, 10);
          n.hide();
          if (matches.length === 0) {
            new Notice('Nenhuma imagem similar encontrada (cache vazio?)');
            return;
          }
          const lines = matches.map(m => `${(m.similarity * 100).toFixed(1)}% — ${m.rel}`);
          try { await navigator.clipboard.writeText(lines.join('\n')); } catch {}
          new Notice(`Top ${matches.length}:\n${lines.slice(0, 5).join('\n')}\n(lista completa no clipboard)`);
          console.log('[zeus] image-similarity matches:', matches);
        } catch (e) {
          n.hide();
          new Notice('Image-similarity falhou: ' + e.message.slice(0, 200));
        }
      },
    });

    // v0.8.0 — native Obsidian Graph integration commands
    this.addCommand({
      id: 'zeus-graph-sync-all',
      name: 'Zeus: sincronizar zeus_related frontmatter em TODAS as notas (graph nativo)',
      callback: async () => {
        if (!this.settings.nativeGraphIntegration) {
          new Notice('Ative "Native graph integration" em Settings → Zeus');
          return;
        }
        const n = new Notice('Zeus: sincronizando frontmatter…', 0);
        await this.nativeGraph.syncAllFiles(msg => n.setMessage('Zeus: ' + msg));
        n.hide();
      },
    });

    this.addCommand({
      id: 'zeus-graph-sync-current',
      name: 'Zeus: sincronizar zeus_related da nota atual',
      callback: async () => {
        const f = this.app.workspace.getActiveFile();
        if (!f) { new Notice('Sem nota ativa'); return; }
        await this.nativeGraph.syncFile(f.path);
        new Notice('Zeus: zeus_related atualizado');
      },
    });

    this.addCommand({
      id: 'zeus-graph-clear',
      name: 'Zeus: limpar zeus_related de TODAS as notas',
      callback: async () => {
        const ok = confirm('Remover zeus_related de todas as notas? Esta operação é reversível mas demora.');
        if (!ok) return;
        const n = new Notice('Zeus: limpando…', 0);
        await this.nativeGraph.clearAll();
        n.hide();
        new Notice('Zeus: zeus_related removido de todas as notas');
      },
    });

    // v0.9.0 — Passport Index Architecture (PIA) commands
    this.addCommand({
      id: 'zeus-passport-build-all',
      name: 'Zeus PIA: extrair passports de TODAS as notas (batch)',
      callback: async () => {
        if (!isMac()) { new Notice('PIA build: requer daemon no Mac'); return; }
        const n = new Notice('Zeus PIA: extracting passports…', 0);
        try {
          const result = await this.passport.buildAll(msg => {
            n.setMessage('Zeus PIA: ' + msg);
            this.updateStatusBar('indexing', msg);
          });
          n.hide();
          this.updateStatusBar('idle', null);
          new Notice(`Zeus PIA: ${result.succeeded} passports, ${result.failed} falhas (${result.total} notas)`);
        } catch (e) {
          n.hide();
          new Notice('Zeus PIA build falhou: ' + e.message.slice(0, 200));
        }
      },
    });

    this.addCommand({
      id: 'zeus-passport-build-current',
      name: 'Zeus PIA: extrair passport da nota atual',
      callback: async () => {
        const f = this.app.workspace.getActiveFile();
        if (!f) { new Notice('Sem nota ativa'); return; }
        const n = new Notice('Zeus PIA: extraindo passport…', 0);
        try {
          const passport = await this.passport.buildOne(f.path);
          n.hide();
          const concepts = (passport.concepts || []).slice(0, 5).join(', ');
          new Notice(`Zeus PIA: ${concepts || 'sem concepts'}`);
        } catch (e) {
          n.hide();
          new Notice('Zeus PIA falhou: ' + e.message.slice(0, 200));
        }
      },
    });

    this.addCommand({
      id: 'zeus-passport-find',
      name: 'Zeus PIA: find — buscar passports por query (MCP-first)',
      callback: () => new ZeusPassportFindModal(this.app, this).open(),
    });

    this.addCommand({
      id: 'zeus-bases-regenerate',
      name: 'Zeus PIA: regenerar zeus-cards.base (UI derivative)',
      callback: async () => {
        try {
          const r = await this.basesGen.regenerate();
          if (r.written) {
            new Notice(`Zeus: zeus-cards.base regenerado (${r.count} passports)`);
          } else {
            new Notice('Zeus: passports.jsonl não existe — rode "build-all" primeiro');
          }
        } catch (e) {
          new Notice('Zeus bases-regenerate falhou: ' + e.message.slice(0, 200));
        }
      },
    });

    // v0.10.0 — scheduler + coordinator commands
    this.addCommand({
      id: 'zeus-scheduler-sweep-now',
      name: 'Zeus: sweep agora (scheduler manual trigger)',
      callback: async () => {
        if (!this.scheduler) { new Notice('Zeus: scheduler indisponível'); return; }
        const n = new Notice('Zeus sweep: rodando…', 0);
        try {
          const r = await this.scheduler.sweep();
          n.hide();
          if (r.skipped === true && r.reason) {
            new Notice('Zeus sweep: ' + r.reason);
          } else {
            new Notice(`Zeus sweep: ${r.extracted} re-extracted, ${r.claimed} claimed, ${r.skipped} skipped, ${r.errors} errors (${r.elapsed}ms)`);
          }
        } catch (e) {
          n.hide();
          new Notice('Zeus sweep falhou: ' + e.message.slice(0, 200));
        }
      },
    });
    this.addCommand({
      id: 'zeus-scheduler-status',
      name: 'Zeus: status do scheduler + claims ativos',
      callback: async () => {
        if (!this.scheduler) { new Notice('Zeus: scheduler indisponível'); return; }
        const s = await this.scheduler.stats();
        const c = s.coordinator || {};
        const last = s.lastSweep
          ? `· last sweep ${new Date(s.lastSweep.at).toLocaleTimeString()} (${s.lastSweep.extracted} extr / ${s.lastSweep.claimed} clm / ${s.lastSweep.skipped} skp / ${s.lastSweep.errors} err)`
          : '· nenhum sweep ainda';
        new Notice(
          `Zeus scheduler: enabled=${s.enabled} running=${s.running} interval=${Math.round(s.intervalMs/60000)}min\n` +
          `Claims ativos: ${c.total || 0} (${c.expired || 0} expired) · device ${c.thisDeviceId}\n` +
          last,
          10000,
        );
        console.log('[zeus] scheduler stats', s);
      },
    });
    this.addCommand({
      id: 'zeus-coord-clean-expired',
      name: 'Zeus: clean expired claims',
      callback: async () => {
        if (!this.coordinator) { new Notice('Zeus: coordinator indisponível'); return; }
        try {
          const n = await this.coordinator.sweepExpired();
          new Notice(`Zeus: ${n} expired claim(s) limpos`);
        } catch (e) {
          new Notice('Zeus clean falhou: ' + e.message.slice(0, 200));
        }
      },
    });

    this.addRibbonIcon('sparkles', 'Zeus search', () => new ZeusSearchModal(this.app, this).open());

    this.registerView(VIEW_TYPE_SMART, leaf => new ZeusSmartView(leaf, this));
    this.registerView(VIEW_TYPE_STATUS, leaf => new ZeusStatusView(leaf, this));

    // v0.8 — StatusBar persistente (clicável)
    this.statusBarEl = this.addStatusBarItem();
    this.statusBarEl.addClass('zeus-status-bar');
    this.statusBarEl.setText('Zeus: …');
    this.statusBarEl.onclick = () => this.activateStatusView();
    this.updateStatusBar('idle', null);

    if (isMac() && this.settings.indexOnSave) {
      this.registerEvent(this.app.vault.on('modify', file => {
        if (file instanceof TFile) this.scheduleIncrementalIndex();
      }));
    }
    // v0.8.0 — native graph auto-resync on save (independent of indexOnSave/Mac)
    if (this.settings.nativeGraphSyncOnSave) {
      this.registerEvent(this.app.vault.on('modify', file => {
        if (file instanceof TFile && file.extension === 'md') {
          // Debounce: re-sync after 6s (after potential reindex)
          clearTimeout(this._graphSyncTimer);
          this._graphSyncTimer = setTimeout(() => {
            this.nativeGraph.syncFile(file.path).catch(e => console.warn('[zeus] graph sync', e.message));
          }, 6000);
        }
      }));
    }
    if (isMac() && this.settings.indexOnStartup) {
      this.app.workspace.onLayoutReady(() => {
        setTimeout(() => this.indexer.runFullIndex(msg => this.updateStatusBar('indexing', msg)), 3000);
      });
    }

    // v0.10.0 — debounced single-file passport re-extract via coordinator
    // Only when scheduler is enabled (it's the orchestrator of the same flow).
    if (this.settings.schedulerEnabled) {
      this._passportRefreshTimers = new Map();
      this.registerEvent(this.app.vault.on('modify', file => {
        if (!(file instanceof TFile) || file.extension !== 'md') return;
        const rel = file.path;
        clearTimeout(this._passportRefreshTimers.get(rel));
        this._passportRefreshTimers.set(rel, setTimeout(async () => {
          this._passportRefreshTimers.delete(rel);
          try {
            const claim = await this.coordinator.claim(rel);
            if (!claim.claimed) return;
            try {
              await this.passport.buildOne(rel);
            } finally {
              await this.coordinator.release(rel);
            }
          } catch (e) {
            console.warn('[zeus] debounced passport refresh failed for', rel, e.message);
          }
        }, 4000));
      }));
    }

    console.log('[zeus] loaded v0.11.2 — distributed coordinator + scheduler');
    trace('onload.complete');
    writeTrace(null);
    } catch (err) {
      console.error('[zeus] ❌ onload FAILED at step:', traceLog[traceLog.length - 1]);
      console.error('[zeus]', err);
      writeTrace(err);
      throw err;
    }
  }

  async onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_SMART);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_STATUS);
    if (this.scheduler) {
      try { this.scheduler.stop(); } catch (e) { console.warn('[zeus] scheduler stop:', e.message); }
    }
    if (this._passportRefreshTimers) {
      for (const t of this._passportRefreshTimers.values()) clearTimeout(t);
      this._passportRefreshTimers.clear();
    }
    if (this.afmDaemon) {
      try { await this.afmDaemon.stop(); } catch (e) { console.warn('[zeus] daemon stop:', e.message); }
    }
  }

  loadIndices() {
    this.searcher.load();
  }

  // v0.11 — async preload of manifest + embeddings via vault.adapter so iOS
  // gets data populated. On Mac the sync load already works; this is a no-op
  // there (sync load returned the right data already).
  async loadIndicesAsync() {
    try {
      this._manifestCache = await this.indexer.loadManifestAsync();
      this._embeddingsCache = await this.indexer.loadEmbeddingsAsync();
      // Refresh searcher with iOS-loaded data.
      if (!fs) {
        this.searcher.embeddings = this._embeddingsCache;
      }
    } catch (e) {
      console.warn('[zeus] loadIndicesAsync failed:', e.message);
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  scheduleIncrementalIndex() {
    clearTimeout(this._idxTimer);
    this._idxTimer = setTimeout(
      () => this.indexer.runFullIndex(msg => this.updateStatusBar('indexing', msg)),
      5000,
    );
  }

  async activateSmartView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_SMART)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_SMART, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  async activateStatusView() {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_STATUS)[0];
    if (!leaf) {
      leaf = workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_STATUS, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  // v0.8 — persistent calibration UI (Smart Connections-style)
  updateStatusBar(state, info) {
    if (!this.statusBarEl) return;
    const emb = this.searcher ? this.searcher.embeddings.size : 0;
    let text;
    if (state === 'indexing') {
      text = `⚡ Zeus indexando: ${info}`;
    } else if (state === 'embedding') {
      text = `🧠 Zeus embedding: ${info}`;
    } else if (state === 'daemon-down') {
      text = `⚠️ Zeus daemon offline`;
    } else {
      text = `✓ Zeus: ${emb} docs`;
    }
    this.statusBarEl.setText(text);
  }

  refreshSmartView() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_SMART)) {
      if (leaf.view && typeof leaf.view.refresh === 'function') leaf.view.refresh();
    }
  }

  // v0.7.0 — small modal-prompt helper used by v0.7 commands
  _zeusPromptText(promptText) {
    return new Promise((resolve) => {
      const { Modal } = obsidian;
      const modal = new Modal(this.app);
      modal.titleEl.setText('Zeus');
      const p = modal.contentEl.createEl('p', { text: promptText });
      p.style.marginBottom = '8px';
      const input = modal.contentEl.createEl('input', { type: 'text' });
      input.style.width = '100%';
      input.style.padding = '6px 8px';
      input.style.boxSizing = 'border-box';
      const btnRow = modal.contentEl.createDiv();
      btnRow.style.marginTop = '12px';
      btnRow.style.display = 'flex';
      btnRow.style.gap = '8px';
      btnRow.style.justifyContent = 'flex-end';
      const okBtn = btnRow.createEl('button', { text: 'OK' });
      okBtn.classList.add('mod-cta');
      const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
      let done = false;
      const finish = (v) => { if (done) return; done = true; resolve(v); modal.close(); };
      okBtn.onclick = () => finish(input.value);
      cancelBtn.onclick = () => finish(null);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(input.value);
        else if (e.key === 'Escape') finish(null);
      });
      modal.onClose = () => { if (!done) resolve(null); };
      modal.open();
      setTimeout(() => input.focus(), 50);
    });
  }
}

module.exports = ZeusPlugin;
