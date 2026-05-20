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
 * Camadas de reasoning (opcionais, default OFF — janela 4096 tokens com
 *  chunking hierárquico NexusSum para docs >10KB via HierarchicalProcessor):
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
//
// v1.4.2 — Discovery vault-agnóstica e device-agnóstica:
//   1. __dirname / __filename quando o Electron loader os preserva
//   2. Stack trace do próprio Error → extrai path do main.js em execução
//   3. Glob de ~/Library/Mobile Documents/iCloud~md~obsidian/Documents/<qualquer-vault>/.obsidian/plugins/zeus
//   4. Fallback final: paths conhecidos (Memoria + vault na raiz Documents)
// Funciona em qualquer vault Obsidian/iCloud, em qualquer Mac, sem hardcoding.
function _zeusFindPluginDir() {
  // v1.4.1-ios — suporte a iOS: fs pode não existir no sandbox Capacitor
  let fs0, path0;
  try { fs0 = require('fs'); } catch (_) { fs0 = null; }
  try { path0 = require('path'); } catch (_) { path0 = null; }

  const isValid = (dir) => {
    try {
      if (!dir || !fs0) return false;
      return fs0.existsSync(dir + '/main.js') && fs0.existsSync(dir + '/manifest.json');
    } catch { return false; }
  };

  // 1) __dirname (macOS Electron preserva; iOS às vezes também)
  try {
    if (typeof __dirname === 'string' && isValid(__dirname)) return __dirname;
  } catch (_) {}

  // 2) Stack trace — regex com suporte a espaços no path (ex: "Mobile Documents")
  // Corrige bug v1.4.0: [^():\s]+ cortava o path em "Mobile Documents" no iOS
  try {
    const stack = new Error().stack || '';
    const re = /(?:\(|at\s+)((?:\/[^():\n]+)+\/main\.js):\d+(?::\d+)?\)?/g;
    let m;
    if (path0) {
      while ((m = re.exec(stack)) !== null) {
        const candidate = path0.dirname(m[1].trim());
        if (isValid(candidate)) return candidate;
      }
    }
  } catch (_) {}

  // 3) iOS: sandbox path /private/var/mobile/Library/Mobile Documents/...
  try {
    if (fs0 && path0) {
      const iosBases = [
        '/private/var/mobile/Library/Mobile Documents/iCloud~md~obsidian/Documents',
        '/var/mobile/Library/Mobile Documents/iCloud~md~obsidian/Documents',
      ];
      for (const base of iosBases) {
        if (!fs0.existsSync(base)) continue;
        const entries = fs0.readdirSync(base, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const candidate = `${base}/${e.name}/.obsidian/plugins/zeus`;
          if (isValid(candidate)) return candidate;
        }
      }
    }
  } catch (_) {}

  // 4) macOS: glob iCloud Drive do usuário
  try {
    if (fs0 && path0) {
      const home = process.env.HOME || ('/Users/' + (process.env.USER || 'rogermaiocchi'));
      const iCloudBase = home + '/Library/Mobile Documents/iCloud~md~obsidian/Documents';
      if (fs0.existsSync(iCloudBase)) {
        const entries = fs0.readdirSync(iCloudBase, { withFileTypes: true });
        for (const e of entries) {
          if (!e.isDirectory()) continue;
          const candidate = `${iCloudBase}/${e.name}/.obsidian/plugins/zeus`;
          if (isValid(candidate)) return candidate;
        }
        const root = `${iCloudBase}/.obsidian/plugins/zeus`;
        if (isValid(root)) return root;
      }
    }
  } catch (_) {}

  // 5) Fallbacks fixos macOS + iOS
  const home = (typeof process !== 'undefined' && process.env && process.env.HOME) || '';
  const fallback = [
    '/private/var/mobile/Library/Mobile Documents/iCloud~md~obsidian/Documents/Memoria/.obsidian/plugins/zeus',
    '/var/mobile/Library/Mobile Documents/iCloud~md~obsidian/Documents/Memoria/.obsidian/plugins/zeus',
    home + '/Library/Mobile Documents/iCloud~md~obsidian/Documents/Memoria/.obsidian/plugins/zeus',
    '/Users/rogermaiocchi/Library/Mobile Documents/iCloud~md~obsidian/Documents/Memoria/.obsidian/plugins/zeus',
    '/Users/maiocchi/Library/Mobile Documents/iCloud~md~obsidian/Documents/Memoria/.obsidian/plugins/zeus',
    '/Users/rogermaiocchi/Library/Mobile Documents/iCloud~md~obsidian/Documents/.obsidian/plugins/zeus',
  ];
  for (const c of fallback) {
    if (isValid(c)) return c;
  }

  // v1.4.3: sem fs (Capacitor) nao da pra VALIDAR caminhos — todas as 5
  // estrategias acima usam fs0.existsSync, que nao existe no iOS. Retorna o
  // caminho deterministico do sandbox iOS; o require() de pluginRequire confirma.
  if (!fs0) {
    return '/private/var/mobile/Library/Mobile Documents/iCloud~md~obsidian/Documents/Memoria/.obsidian/plugins/zeus';
  }
  throw new Error('Zeus pluginRequire: cannot locate plugin dir (procurei __dirname, stack, iOS sandbox, glob iCloud, fallbacks)');
}
const _ZEUS_PLUGIN_DIR = _zeusFindPluginDir();
// v1.4.2-ios: require('path') unguarded crashava plugin no iPad/iPhone (Capacitor sandbox).
let _zeusPath = null;
try { _zeusPath = require('path'); } catch (_) { /* iOS sandbox — usa join string */ }
function pluginRequire(rel) {
  const full = (_zeusPath && _zeusPath.join)
    ? _zeusPath.join(_ZEUS_PLUGIN_DIR, rel)
    : (_ZEUS_PLUGIN_DIR + '/' + rel).replace(/\/+/g, '/');
  return require(full);
}
console.log('[zeus] pluginRequire base:', _ZEUS_PLUGIN_DIR);


const obsidian = require('obsidian');
const { Plugin, PluginSettingTab, Setting, SuggestModal, ItemView, Notice, TFile } = obsidian;

// v0.11 — universal Mac+iOS: Node modules wrapped in try/catch so plugin loads
// in Capacitor sandbox (iPad/iPhone). Use `universal.X` for cross-platform ops;
// fall through to `spawn/path/fs` only when guarded by `if (universal.IS_NODE)`.
const universal = require('./lib/universal-fs');

// v0.11 — Backward compat: legacy code in main.js references `path`/`fs` directly.
// On iOS these are null (not undefined → não dispara ReferenceError quando avaliado
// em expressões como `if (path && ...)`).  Code DEVE checar truthy antes de usar.
const path = universal.nodePath;
const fs = universal.nodeFs;
const spawn = universal.nodeChildProcess ? universal.nodeChildProcess.spawn : null;

// v0.5.0 — modular extensions (parallel-built by subagents)
const HierarchicalProcessor = require('./lib/hierarchical'); // Fix 2: NexusSum-pattern long-doc enrich
const MultiVectorEmbedder = require('./lib/multi-vector');   // Fix 4: 3×512=1536-dim effective coverage
const ZeusHttpClient = require('./lib/zeus-http-client');    // v0.6: Aegis-pattern daemon HTTP transport (ADR-018)
const ImageSimilaritySearch = require('./lib/image-similarity'); // v0.7: feature-print vault image similarity
const PassportIndex = require('./lib/passport-index');       // v0.9: Passport Index Architecture (PIA)
const BasesGenerator = require('./lib/bases-generator');     // v0.9: Obsidian Bases UI derivative from passports.jsonl
const DistributedCoordinator = require('./lib/distributed-coordinator'); // v0.10: cross-device claim/release via iCloud lock files
const PassportScheduler = require('./lib/passport-scheduler');           // v0.10: background sweep for stale passports
const DaemonLifecycle = require('./lib/daemon-lifecycle');               // v1.5: auto-spawn bin/ZeusDaemonMac (autonomia total Mac)
const HybridSearch = require('./lib/hybrid-search');                     // v1.6: RRF semantic+graph+passport+path
const NativeWatcher = require('./lib/native-watcher');                   // v1.6: FSEvents observability (Mac iCloud)

const VIEW_TYPE_SMART = 'zeus-smart-view';
const VIEW_TYPE_STATUS = 'zeus-status-view';
const DATA_DIR_NAME = 'data';
const EMBEDDINGS_FILE = 'embeddings.jsonl';
const MANIFEST_FILE = 'manifest.json';
const OCR_CACHE_DIR = 'aocr-cache';            // ex-ocr-cache
const IMAGE_FEAT_CACHE_DIR = 'av-cache';       // image features (classify + landmarks + EXIF)
const ENRICH_CACHE_DIR = 'aia-enrich-cache';   // ex-enrich-cache (AIA = Apple Intelligence)

// v1.5 — CLI afm/metafm removido. Daemon HTTP (bin/ZeusDaemonMac) é a única
// superfície de execução. iOS degrada gracioso quando daemon não é alcançável.

// v1.3.3 — real-time audio indexing
// Extensões processadas via /v1/asp/vad → /v1/asp/transcribe → /v1/embed
const AUDIO_EXTENSIONS = new Set(['m4a', 'wav', 'mp3']);

const DEFAULT_SETTINGS = {
  indexOnStartup: true,
  indexOnSave: true,
  ocrEnabled: true,
  embedBackend: 'apple',          // apple = NLContextualEmbedding (dim 512); e5 = multilingual (dim 384)
  fileTypes: { md: true, pdf: true, png: true, jpg: true, jpeg: true, heic: true, m4a: true, wav: true, mp3: true },
  // v1.3.3 — audio indexing
  audioLocale: 'pt-BR',                  // BCP47 default para SpeechAnalyzer/SFSpeechRecognizer
  audioEngine: 'auto',                   // sa|sf|auto — daemon escolhe melhor disponível
  audioVadEnabled: true,                 // pre-filter via /v1/asp/vad antes de transcribe
  folderExclusions: ['.trash', '.obsidian', '.smart-env', 'node_modules', 'Attachments'],
  exactMatchBoost: 0.5,
  maxResults: 30,
  smartNeighborsCount: 8,
  excerptLength: 220,
  minDocChars: 30,
  // FoundationModels reasoning layer (janela 4096 tokens; chunking hierárquico NexusSum
  // ativa automaticamente para docs >10KB via hierarchicalThreshold)
  enrichOnOpen: false,            // default off — opt-in via Settings
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
  // v0.5.0 — Hierarchical processor (Fix 2)
  hierarchicalThreshold: 10000,   // chars above which enrich delega para HierarchicalProcessor (NexusSum)
  // v0.5.0 — Multi-vector embedding (Fix 4)
  multiVectorEnabled: false,      // off until reindex; flip after primeiro reindex c/ multi-vector
  multiVectorIndexOnReindex: false, // se true, runFullIndex produz multi-vectors.jsonl além de embeddings.jsonl
  // v0.6.0 — Aegis-pattern HTTP daemon (ADR-018)
  zeusDaemonUrl: 'http://127.0.0.1:2223',   // local daemon loopback; cross-device via Tailscale: http://100.65.240.43:2223
  daemonPreferredOverSpawn: true,            // ADR-018 fase E++: HTTP-first em todos hot paths; spawn é fallback no Mac
  // v1.4.1 — On-device-first: cada device Apple roda seu próprio daemon nativo
  // (ZeusDaemonMac no macOS, AegisDaemon no iOS). Quando ON, discovery cai para
  // Tailscale mesh apenas se o daemon local não responder. Quando OFF, Tailscale
  // mesh nunca é tentado — modo strict on-device (melhor privacidade + latência).
  allowRemoteDaemonFallback: true,
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
  // v1.1 — Status bar: token-saved metrics
  showTokenSavedInStatusBar: true,          // exibe "k tok saved" via PIA no status bar
  statusBarRefreshIntervalMs: 30000,        // 30s refresh para tokens metrics
  rawTokenBaseline: 1250,                   // tokens médios sem PIA por request (~5KB/4)
  // v2.0 — Apple Cloud Private (ACP / PCC)
  // 'off'    = só on-device (privacy máximo, requer macOS 26+ Apple Intelligence)
  // 'opt-in' = client envia header X-Zeus-Allow-Pcc:1; daemon decide caso a caso
  // 'auto'   = sempre permite roteamento para PCC quando on-device excede capacidade
  pccMode: 'off',
  pccVisualIndicator: true,                 // exibe ☁️PCC no status bar quando daemon roteou via PCC
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

function isMac() {
  // process.platform doesn't exist on iOS (Capacitor) — fallback to UA detection.
  return universal.isMacLike();
}

// =========================================================================
// HTTP-only dispatcher (ADR-018 Aegis pattern, v1.5 — autonomous daemon)
// -------------------------------------------------------------------------
// Plugin v1.5 abandona o caminho child_process.spawn — toda operação Apple
// passa pelo daemon HTTP local (bin/ZeusDaemonMac auto-spawned no Mac via
// DaemonLifecycle, AegisDaemon embebido no host app no iOS). Retorna shape
// { source, result } por compatibilidade com callsites legados.
// -------------------------------------------------------------------------
async function tryDaemonOrSpawn(plugin, daemonMethod, daemonArgs /* spawnArgs, stdinText, timeoutMs ignorados */) {
  if (!plugin.httpClient || typeof plugin.httpClient[daemonMethod] !== 'function') {
    throw new Error(`Daemon method indisponível: ${daemonMethod}`);
  }
  const reachable = await plugin.httpClient.isAvailable();
  if (!reachable) {
    throw new Error(`Daemon HTTP fora do ar (${plugin.httpClient.baseUrl}) — ${daemonMethod} não pôde rodar`);
  }
  const result = await plugin.httpClient[daemonMethod](...daemonArgs);
  return { source: 'daemon', result };
}

// v0.6.1 — Adaptive daemon discovery: tries local loopback, then Tailscale mesh
// Per device, prefers: 127.0.0.1 (same device daemon) > device-specific Tailscale (mesh peer)
// v1.4.1 — Inclui hostnames mDNS/.local como fallback para LAN local (sem Tailscale).
const TAILSCALE_MESH = [
  // Order matters — closest/fastest first
  'http://127.0.0.1:2223',                  // local daemon (any device)
  'http://100.108.238.49:2223',             // rogers-mac-mini (Tailscale, macOS)
  'http://100.86.123.88:2223',              // macbook-air-de-roger (Tailscale, macOS)
  'http://100.91.107.120:2223',             // ipad-air-gen-4 (Tailscale, iOS)
  'http://100.65.240.43:2223',              // iphone-15 (Tailscale, iOS)
  'http://rogers-mac-mini.local:2223',      // mDNS/Bonjour fallback (LAN local sem Tailscale)
];

// v1.4.1 — Per-device cache: localStorage não é sincronizado via iCloud, então cada device
// memoriza sua própria URL funcional. Evita re-discovery em todo startup.
//
// IMPORTANTE — arquitetura on-device-first (Apple-native em TODOS os devices):
//   Cada device (Mac mini, MacBook Air, iPad, iPhone) roda seu próprio daemon nativo
//   em 127.0.0.1:2223. macOS: ZeusDaemonMac (LaunchAgent). iOS: AegisDaemon embedado
//   no app Aegis. Tailscale mesh é apenas FALLBACK degradado quando o daemon local
//   não está rodando — não a rota normal.
//
//   Por isso o cache só persiste 127.0.0.1: se cachearmos um peer Tailscale, o device
//   ficaria preso ali mesmo quando o daemon local subir. Toda boot reavalia o local.
const ZEUS_LOCAL_DAEMON_KEY = 'zeus.daemon.url';        // cached URL string (sempre 127.0.0.1:* quando cacheado)
const ZEUS_LOCAL_DAEMON_TS_KEY = 'zeus.daemon.ts';      // cached at (ms)
const ZEUS_LOCAL_DAEMON_TTL_MS = 12 * 60 * 60 * 1000;   // 12h — re-probe periodicamente

function _zeusIsLoopback(url) {
  if (!url) return false;
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(url);
}

function _zeusGetLocalDaemonUrl() {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    const url = window.localStorage.getItem(ZEUS_LOCAL_DAEMON_KEY);
    const ts = parseInt(window.localStorage.getItem(ZEUS_LOCAL_DAEMON_TS_KEY) || '0', 10);
    if (!url || !ts) return null;
    if (Date.now() - ts > ZEUS_LOCAL_DAEMON_TTL_MS) return null;
    return url;
  } catch { return null; }
}

function _zeusSetLocalDaemonUrl(url) {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return;
    if (!url) {
      window.localStorage.removeItem(ZEUS_LOCAL_DAEMON_KEY);
      window.localStorage.removeItem(ZEUS_LOCAL_DAEMON_TS_KEY);
      return;
    }
    // Só cacheia loopback — URL remota não é "estado estável" do device.
    if (!_zeusIsLoopback(url)) {
      console.log('[zeus] cache skip — URL não é loopback (sempre re-probe local primeiro):', url);
      return;
    }
    window.localStorage.setItem(ZEUS_LOCAL_DAEMON_KEY, url);
    window.localStorage.setItem(ZEUS_LOCAL_DAEMON_TS_KEY, String(Date.now()));
  } catch {}
}

// v1.4.1 — On-device-first daemon discovery.
//
// Ordem fixa de candidatos:
//   1. 127.0.0.1:2223  — daemon LOCAL Apple-nativo (ZeusDaemonMac no Mac, AegisDaemon no iOS)
//   2. localhost:2223  — alternativa de hostname para o mesmo loopback
//   3. settings.zeusDaemonUrl — override sincronizado via iCloud (geralmente também 127.0.0.1)
//   4. TAILSCALE_MESH — fallback degradado SE allowRemoteDaemonFallback estiver ON
//
// Probes em paralelo com timeout curto (1500ms). MAS o resultado é PRIORIZADO por
// ordem de preferência: se loopback responde, vence sobre Tailscale mesmo que Tailscale
// tenha respondido primeiro. Isso garante "local sempre que possível".
async function discoverDaemonUrl(plugin, candidates = null, probeTimeoutMs = 1500) {
  const allowRemote = plugin.settings.allowRemoteDaemonFallback !== false;  // default true

  const ordered = [];
  const seen = new Set();
  const push = (u) => { if (u && !seen.has(u)) { seen.add(u); ordered.push(u); } };

  if (candidates) {
    for (const u of candidates) push(u);
  } else {
    // 1+2: loopback (sempre primeiro — daemon local Apple-nativo daquele device)
    push('http://127.0.0.1:2223');
    push('http://localhost:2223');
    // 3: settings (sincronizado via iCloud — geralmente loopback, mas pode ser custom)
    push(plugin.settings.zeusDaemonUrl);
    // 4: mesh remoto (só se fallback permitido)
    if (allowRemote) {
      for (const u of TAILSCALE_MESH) push(u);
    }
  }

  const ZeusHttpClientLocal = require('./lib/zeus-http-client');
  // Probe em paralelo — mas pondera resultado pela posição (loopback ganha de remoto).
  const probes = ordered.map((url, idx) => (async () => {
    try {
      const client = new ZeusHttpClientLocal(url);
      const ok = await client.isAvailable(probeTimeoutMs);
      return ok ? { url, idx, loopback: _zeusIsLoopback(url) } : null;
    } catch { return null; }
  })());

  const results = await Promise.allSettled(probes);
  const winners = results
    .filter(r => r.status === 'fulfilled' && r.value)
    .map(r => r.value);

  if (winners.length === 0) {
    console.warn('[zeus] adaptive daemon discovery → NENHUM daemon respondeu (nem local nem mesh)');
    return plugin.settings.zeusDaemonUrl;  // mantém o default para tentar de novo depois
  }

  // Prioriza loopback (on-device); se nenhum loopback, usa o de menor idx (mesh ordenado por proximidade).
  const loopback = winners.find(w => w.loopback);
  const chosen = loopback || winners.sort((a, b) => a.idx - b.idx)[0];

  console.log('[zeus] adaptive daemon discovery → using', chosen.url,
    chosen.loopback ? '(LOCAL on-device daemon ✓)' : '(REMOTE Tailscale fallback ⚠)');

  _zeusSetLocalDaemonUrl(chosen.url);   // só cacheia se for loopback (helper filtra)
  return chosen.url;
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
    this.SYNC_DEBOUNCE_MS = 3000;
    this.FRONTMATTER_KEY = 'zeus_related';
    this.FRONTMATTER_GRAPH_KEY = 'zeus_graph_related';
    // v1.6 — codex HIGH #2: tracking in-flight para evitar loop de escrita
    // (write → modify event → sync schedule → write …). Map de path → SHA do
    // último frontmatter value escrito; só re-escreve quando o array calculado
    // diverge do escrito anteriormente.
    this._lastWritten = new Map();        // path → sha-of-array
    this._inFlight = new Set();           // paths atualmente sendo processados
  }

  _arraySha(arr) {
    const txt = (arr || []).join('\n');
    if (universal.nodeCrypto && universal.nodeCrypto.createHash) {
      return universal.nodeCrypto.createHash('sha256').update(txt).digest('hex').slice(0, 16);
    }
    let h = 0; for (let i = 0; i < txt.length; i++) h = ((h << 5) - h + txt.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  _renderLinks(items) {
    return items.map((n) => {
      const name = String(n.path || '').replace(/\.md$/, '');
      const alias = name.split('/').pop();
      const pct = typeof n.score === 'number' ? ` (${(n.score * 100).toFixed(0)}%)` : '';
      return `[[${name}|${alias}${pct}]]`;
    });
  }

  // Top-N neighbors da nota (cosine NL), injeta como wikilinks no frontmatter.
  // v1.6 — compara SHA antes de escrever, evita timestamp churn.
  // v1.6.1 — codex MED #1: quando filtered fica vazio, REMOVE zeus_related em vez
  // de fazer no-op (que deixava arestas stale no Graph nativo).
  async syncFile(filePath, topN = 5, minScore = 0.3) {
    if (!this.plugin.settings.nativeGraphIntegration) return;
    if (this._inFlight.has(filePath)) return;
    const neighbors = this.plugin.searcher.neighbors(filePath, topN);
    const filtered = neighbors.filter(n => n.score >= minScore);

    const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
    if (!file) return;

    const wikilinks = this._renderLinks(filtered);
    const sha = this._arraySha(wikilinks);
    const cacheKey = `${filePath}|${this.FRONTMATTER_KEY}`;
    if (this._lastWritten.get(cacheKey) === sha) return;

    this._inFlight.add(filePath);
    try {
      await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
        const current = Array.isArray(fm[this.FRONTMATTER_KEY]) ? fm[this.FRONTMATTER_KEY] : null;
        const currentSha = current ? this._arraySha(current) : null;
        if (currentSha === sha) return; // já em sync no disco
        if (wikilinks.length === 0) {
          delete fm[this.FRONTMATTER_KEY];
          delete fm.zeus_neighbor_count;
          delete fm.zeus_indexed_at;
        } else {
          fm[this.FRONTMATTER_KEY] = wikilinks;
          fm.zeus_neighbor_count = filtered.length;
          // zeus_indexed_at só muda quando o conjunto realmente mudou (já garantido
          // pelo SHA check). Quebra o loop iCloud↔Obsidian.
          fm.zeus_indexed_at = new Date().toISOString();
        }
      });
      this._lastWritten.set(cacheKey, sha);
    } finally {
      this._inFlight.delete(filePath);
    }
  }

  // v1.6 — codex MED #1 + user request "Graphify 100% integrado com graph nativo".
  // Roda afm graph-extract (entidades + arestas) e escreve as entidades cujos
  // basenames existem no vault como wikilinks em `zeus_graph_related`. Obsidian
  // native Graph View renderiza estas como arestas naturais.
  //
  // Manual/on-command apenas — graph-extract é caro (~3-8s/nota), não roda em
  // real-time pra não competir com pipeline de embed.
  async syncFromGraphExtract(filePath) {
    // codex HIGH #1: lock antes do `await graphExtractor.extract()` para que
    // duas invocações concorrentes não disparem extract+write em paralelo.
    // Toda a operação envelopada em try/finally.
    if (this._inFlight.has(filePath)) return { skipped: 'in-flight' };
    if (!this.plugin.graphExtractor) return { error: 'graphExtractor indisponível' };
    const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
    if (!file) return { error: 'arquivo não encontrado no vault' };

    this._inFlight.add(filePath);
    try {
      let graph;
      try {
        graph = await this.plugin.graphExtractor.extract(filePath);
      } catch (e) {
        return { error: 'graph-extract: ' + (e.message || String(e)).slice(0, 200) };
      }
      const nodes = Array.isArray(graph && graph.nodes) ? graph.nodes : [];

      // Resolve entidades via metadataCache (codex pré-fix MED #2)
      const mdc = this.plugin.app.metadataCache;
      const matches = [];
      const seen = new Set();
      for (const node of nodes) {
        const label = String((node && (node.id || node.label || node.name)) || '').trim();
        if (!label || label.length < 2) continue;
        const dest = mdc.getFirstLinkpathDest ? mdc.getFirstLinkpathDest(label, filePath) : null;
        if (dest && dest.path && dest.path !== filePath && !seen.has(dest.path)) {
          seen.add(dest.path);
          matches.push({ path: dest.path, score: undefined, label });
        }
      }

      const wikilinks = this._renderLinks(matches);
      const sha = this._arraySha(wikilinks);
      const cacheKey = `${filePath}|${this.FRONTMATTER_GRAPH_KEY}`;
      if (this._lastWritten.get(cacheKey) === sha) {
        return matches.length
          ? { skipped: 'já sincronizado', count: matches.length }
          : { skipped: 'já vazio (sem matches)', nodes: nodes.length };
      }

      // codex MED #1: quando resultado é vazio, NÃO retorna skipped sem limpar;
      // remove entradas stale para que o Graph nativo deixe de mostrar arestas mortas.
      await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
        const current = Array.isArray(fm[this.FRONTMATTER_GRAPH_KEY]) ? fm[this.FRONTMATTER_GRAPH_KEY] : null;
        if (current && this._arraySha(current) === sha) return;
        if (wikilinks.length === 0) {
          delete fm[this.FRONTMATTER_GRAPH_KEY];
          delete fm.zeus_graph_node_count;
          delete fm.zeus_graph_synced_at;
        } else {
          fm[this.FRONTMATTER_GRAPH_KEY] = wikilinks;
          fm.zeus_graph_node_count = nodes.length;
          fm.zeus_graph_synced_at = new Date().toISOString();
        }
      });
      this._lastWritten.set(cacheKey, sha);
      return matches.length
        ? { ok: true, count: matches.length, nodes: nodes.length }
        : { ok: true, cleared: true, nodes: nodes.length };
    } finally {
      this._inFlight.delete(filePath);
    }
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

  // v1.6 — codex MED #1: clearAll agora limpa ambos zeus_related e zeus_graph_related.
  async clearAll() {
    const files = this.plugin.app.vault.getMarkdownFiles();
    for (const file of files) {
      await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
        delete fm[this.FRONTMATTER_KEY];
        delete fm[this.FRONTMATTER_GRAPH_KEY];
        delete fm.zeus_indexed_at;
        delete fm.zeus_neighbor_count;
        delete fm.zeus_graph_node_count;
        delete fm.zeus_graph_synced_at;
      });
    }
    this._lastWritten.clear();
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
// v1.6 — Modais híbridos (RRF semantic+graph+passport+path)
// =========================================================================

// Busca livre estilo Cmd+P unificado (codex MED #3: complementa, não substitui
// o Quick Switcher nativo). Cada hit traz badges das fontes que o ranquearam.
class ZeusHybridSearchModal extends SuggestModal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
    this.setPlaceholder('Zeus — busca híbrida (semantic ⊕ graph ⊕ passport ⊕ path)…');
    this.cached = [];
    this.lastQuery = '';
    // codex MED #4: querySeq monotônico — respostas async stale são descartadas
    // se o usuário continuou digitando antes do RRF retornar.
    this._querySeq = 0;
  }
  async getSuggestions(q) {
    if (!q || q.length < 2) return [];
    if (q === this.lastQuery) return this.cached;
    this.lastQuery = q;
    const seq = ++this._querySeq;
    try {
      const r = await this.plugin.hybrid.query(q, this.plugin.settings.maxResults || 30);
      if (seq !== this._querySeq) return this.cached; // resposta stale — usuário já digitou outra coisa
      this.cached = r;
      return r;
    } catch (e) {
      console.warn('[zeus] hybrid query failed', e.message);
      return [];
    }
  }
  renderSuggestion(hit, el) {
    el.empty();
    el.addClass('zeus-result');
    const head = el.createDiv({ cls: 'zeus-result-head' });
    const name = hit.path.replace(/\.md$/, '').split('/').pop();
    head.createSpan({ cls: 'zeus-result-title', text: name });
    const meta = head.createSpan({ cls: 'zeus-result-meta' });
    for (const src of (hit.sources || [])) {
      meta.createSpan({ cls: `zeus-badge zeus-badge-${src}`, text: src });
    }
    meta.createSpan({ cls: 'zeus-badge zeus-badge-sem', text: hit.score.toFixed(3) });
    el.createDiv({ cls: 'zeus-result-path', text: hit.path });
  }
  async onChooseSuggestion(hit) {
    const file = this.app.vault.getAbstractFileByPath(hit.path);
    if (file instanceof TFile) await this.app.workspace.getLeaf().openFile(file);
  }
}

// Modal de resultados estático (notas-irmãs do arquivo atual).
class ZeusHybridResultsModal extends SuggestModal {
  constructor(app, plugin, items, title) {
    super(app);
    this.plugin = plugin;
    this.items = items;
    this.setPlaceholder(title || 'Zeus — resultados híbridos');
  }
  getSuggestions(q) {
    if (!q) return this.items;
    const qn = q.toLowerCase();
    return this.items.filter(it => (it.path || '').toLowerCase().includes(qn));
  }
  renderSuggestion(hit, el) {
    el.empty();
    el.addClass('zeus-result');
    const head = el.createDiv({ cls: 'zeus-result-head' });
    const name = hit.path.replace(/\.md$/, '').split('/').pop();
    head.createSpan({ cls: 'zeus-result-title', text: name });
    const meta = head.createSpan({ cls: 'zeus-result-meta' });
    for (const src of (hit.sources || [])) {
      meta.createSpan({ cls: `zeus-badge zeus-badge-${src}`, text: src });
    }
    meta.createSpan({ cls: 'zeus-badge zeus-badge-sem', text: hit.score.toFixed(3) });
    el.createDiv({ cls: 'zeus-result-path', text: hit.path });
  }
  async onChooseSuggestion(hit) {
    const file = this.app.vault.getAbstractFileByPath(hit.path);
    if (file instanceof TFile) await this.app.workspace.getLeaf().openFile(file);
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

    // v1.5 — Daemon HTTP (bin/ZeusDaemonMac) é a única superfície Apple. CLI removida.
    const _lcStatus = (this.plugin.daemonLifecycle && this.plugin.daemonLifecycle.lastStatus) || null;
    const _lcLabel = _lcStatus
      ? `${_lcStatus.running ? 'ALIVE' : 'DEAD'} (${_lcStatus.source}) — ${this.plugin.daemonLifecycle.url}`
      : 'aguardando primeira verificação';
    new Setting(containerEl)
      .setName('Daemon HTTP (bin/ZeusDaemonMac)')
      .setDesc(`Auto-spawn no Mac quando 127.0.0.1:2223 não responde. iOS consome via Tailscale/iCloud read-only. Estado: ${_lcLabel}`);

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
      .setName('Zeus daemon URL (sincronizado via iCloud)')
      .setDesc('Setting compartilhada. Mantenha em http://127.0.0.1:2223 — cada device Apple roda seu PRÓPRIO daemon nativo (ZeusDaemonMac no macOS, AegisDaemon no iOS) e o discovery sempre tenta o loopback primeiro. Tailscale fica só como fallback quando o daemon local não está rodando.')
      .addText(t => t.setValue(this.plugin.settings.zeusDaemonUrl).setPlaceholder('http://127.0.0.1:2223').onChange(async v => {
        this.plugin.settings.zeusDaemonUrl = v;
        await this.plugin.saveSettings();
        this.plugin.httpClient.setBaseUrl(v);
        // v1.4.1 — Limpa cache localStorage para que o novo valor seja reprobado.
        _zeusSetLocalDaemonUrl(null);
      }));

    new Setting(containerEl)
      .setName('Permitir fallback remoto via Tailscale')
      .setDesc('Default ON: se o daemon local 127.0.0.1:2223 não responde (ainda não instalado neste device), tenta peers Tailscale (Mac mini, MacBook, iPad, iPhone). OFF = modo strict on-device: nunca conecta a outro device — exige daemon Apple-nativo local funcionando. Recomendado OFF depois que todos os devices tiverem seu daemon próprio.')
      .addToggle(t => t.setValue(this.plugin.settings.allowRemoteDaemonFallback !== false).onChange(async v => {
        this.plugin.settings.allowRemoteDaemonFallback = v;
        await this.plugin.saveSettings();
        // Invalida cache para forçar reavaliação na próxima discovery
        _zeusSetLocalDaemonUrl(null);
      }));

    new Setting(containerEl)
      .setName('Forçar redescoberta de daemon agora')
      .setDesc('Limpa cache localStorage e probe 127.0.0.1 + settings + TAILSCALE_MESH em paralelo. Loopback (daemon local Apple-nativo) sempre ganha quando responde. Use após instalar o daemon local ou mover entre redes.')
      .addButton(b => b.setButtonText('Redescobrir').setCta().onClick(async () => {
        _zeusSetLocalDaemonUrl(null);
        const n = new Notice('Zeus: redescobrindo daemon…', 0);
        try {
          const url = await discoverDaemonUrl(this.plugin);
          this.plugin.httpClient.setBaseUrl(url);
          const ok = await this.plugin.httpClient.isAvailable(1500);
          n.hide();
          if (ok) {
            const isLocal = _zeusIsLoopback(url);
            new Notice(`Zeus: daemon ${isLocal ? 'LOCAL on-device ✓' : 'REMOTE (fallback Tailscale) ⚠'} em ${url}`, 6000);
          } else {
            const macHint = 'macOS: rode `bash daemon/scripts/install-mac-daemon.sh` para subir o ZeusDaemonMac via LaunchAgent.';
            const iosHint = 'iOS: abra o app Aegis para iniciar o AegisDaemon (porta 2223 embedada).';
            new Notice(`Zeus: nenhum daemon respondeu.\n${isMac() ? macHint : iosHint}`, 12000);
          }
          this.display();
        } catch (e) {
          n.hide();
          new Notice(`Zeus: discovery falhou — ${e.message}`, 8000);
        }
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

    // ────────────────────────────────────────────────────────────────────
    // v1.1 — Métricas no Status Bar
    // ────────────────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'v1.1 — Status Bar & Token Metrics' });
    const metricsDesc = containerEl.createEl('p', { cls: 'setting-item-description' });
    metricsDesc.appendText('Status bar exibe contagem de docs indexados e, opcionalmente, tokens economizados via ');
    metricsDesc.createEl('strong', { text: 'Passport Index Architecture (PIA)' });
    metricsDesc.appendText(': passports compactos (~300B) substituem conteúdo bruto (~5KB) em chamadas agênticas.');

    new Setting(containerEl)
      .setName('Mostrar tokens economizados no status bar')
      .setDesc('Exibe formato "Zeus: 1245 docs · 18.3k tok saved". Baseline configurável abaixo.')
      .addToggle(t => t.setValue(this.plugin.settings.showTokenSavedInStatusBar).onChange(async v => {
        this.plugin.settings.showTokenSavedInStatusBar = v;
        await this.plugin.saveSettings();
        this.plugin.updateStatusBar('idle', null);
      }));

    new Setting(containerEl)
      .setName('Intervalo de refresh do status bar (ms)')
      .setDesc('Atualiza tokens economizados periodicamente. Default 30000 (30s). Aumente para reduzir overhead, diminua para feedback mais responsivo.')
      .addSlider(s => s.setLimits(5000, 120000, 5000).setValue(this.plugin.settings.statusBarRefreshIntervalMs).setDynamicTooltip().onChange(async v => {
        this.plugin.settings.statusBarRefreshIntervalMs = v;
        await this.plugin.saveSettings();
        if (this.plugin._statusBarTimer) {
          clearInterval(this.plugin._statusBarTimer);
          this.plugin._statusBarTimer = setInterval(() => {
            if (this.plugin._lastStatusBarState === 'idle' || !this.plugin._lastStatusBarState) {
              this.plugin.updateStatusBar('idle', null);
            }
          }, v);
        }
      }));

    new Setting(containerEl)
      .setName('Token baseline (raw sem PIA)')
      .setDesc('Tokens médios estimados por request se carga raw fosse enviada ao invés de passport. Default 1250 (~5KB/4). Ajuste se notas do vault forem tipicamente maiores/menores.')
      .addSlider(s => s.setLimits(250, 5000, 50).setValue(this.plugin.settings.rawTokenBaseline).setDynamicTooltip().onChange(async v => {
        this.plugin.settings.rawTokenBaseline = v;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Reset métricas')
      .setDesc('Zera contadores de tokens, bytes e requests do HTTP client. Útil após mudar baseline ou debugar.')
      .addButton(b => b.setButtonText('Reset').onClick(() => {
        if (this.plugin.httpClient) this.plugin.httpClient.resetMetrics();
        new Notice('Zeus: métricas zeradas');
        this.plugin.updateStatusBar('idle', null);
      }));

    // ────────────────────────────────────────────────────────────────────
    // v2.0 — Apple Cloud Private (ACP / PCC)
    // ────────────────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: 'v2.0 — Apple Cloud Private (PCC)' });
    const pccDesc = containerEl.createEl('p', { cls: 'setting-item-description' });
    pccDesc.appendText('Private Cloud Compute (PCC) é a camada de cloud do Apple Intelligence — modelos servidor-side rodam em hardware Apple verificável criptograficamente, sem reter dados. Usa sua assinatura Apple Intelligence já ativa. ');
    pccDesc.createEl('strong', { text: 'Apenas para queries que excedem capacidade on-device' });
    pccDesc.appendText(' (notas grandes, agent multi-step com janela 4096 estourada). Requer macOS 26+ Apple Intelligence ativo no device do daemon.');

    new Setting(containerEl)
      .setName('Modo PCC')
      .setDesc('off = só on-device (privacy máximo, default). opt-in = client envia header X-Zeus-Allow-Pcc:1; daemon decide caso a caso. auto = daemon roteia para PCC quando on-device excede capacidade.')
      .addDropdown(d => d
        .addOption('off', 'off — só on-device (default)')
        .addOption('opt-in', 'opt-in — header X-Zeus-Allow-Pcc:1')
        .addOption('auto', 'auto — daemon decide')
        .setValue(this.plugin.settings.pccMode)
        .onChange(async v => {
          this.plugin.settings.pccMode = v;
          await this.plugin.saveSettings();
          if (this.plugin.httpClient) this.plugin.httpClient.setPccMode(v);
          this.plugin.updateStatusBar('idle', null);
        }));

    new Setting(containerEl)
      .setName('Indicador visual PCC no status bar')
      .setDesc('Quando PCC é usado, status bar exibe "☁️PCC×N" (N = contagem de requests roteadas via PCC nesta sessão). Default ON quando pccMode ≠ off.')
      .addToggle(t => t.setValue(this.plugin.settings.pccVisualIndicator).onChange(async v => {
        this.plugin.settings.pccVisualIndicator = v;
        await this.plugin.saveSettings();
        this.plugin.updateStatusBar('idle', null);
      }));

    new Setting(containerEl)
      .setName('Status PCC')
      .setDesc('Inspeciona modo atual e contadores de uso PCC desde a última sessão.')
      .addButton(b => b.setButtonText('Mostrar').onClick(() => {
        if (!this.plugin.httpClient) { new Notice('Zeus: HTTP client indisponível'); return; }
        const s = this.plugin.httpClient.getPccStatus();
        new Notice(
          `Zeus PCC\nmodo: ${s.mode}\núltima req via PCC: ${s.lastUsed ? 'sim' : 'não'}\ntotal PCC nesta sessão: ${s.totalUsageCount}`,
          8000,
        );
      }));

    // ────────────────────────────────────────────────────────────────────
    // Ações finais
    // ────────────────────────────────────────────────────────────────────
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
    console.log('[zeus] platform:', universal.detectPlatform(), '| vaultRoot:', this.vaultRoot || '(adapter-only)');
    this.indexer = new ZeusIndexer(this);
    this.searcher = new ZeusSearcher(this);
    this.enricher = new ZeusEnricher(this);
    this.agent = new ZeusVaultAgent(this);
    this.av = new AppleVisionIntelligence(this);
    this.hyde = new HyDEExpander(this);
    this.graphExtractor = new ZeusGraphExtractor(this);
    this.nativeGraph = new ZeusNativeGraphIntegration(this);
    // v1.6 — busca híbrida (RRF semantic+graph+passport+path)
    this.hybrid = new HybridSearch(this);
    // v1.6 — FSEvents observability (Mac apenas; iOS é no-op).
    this.nativeWatcher = new NativeWatcher(this);

    // v0.5.0 — modular extensions
    // pluginDataPath: absolute on Mac, vault-relative on iOS (multi-vector saveAll
    // is Mac-only anyway — gated by isMac() before invocation).
    const pluginDataPath = (path && this.vaultRoot)
      ? path.join(this.vaultRoot, this.manifest.dir, DATA_DIR_NAME)
      : universal.joinPath(this.manifest.dir, DATA_DIR_NAME);
    // v1.5 — HierarchicalProcessor e MultiVectorEmbedder herdaram dependência
    // de `afmBin` (spawn child_process). Mantemos a assinatura por compat —
    // passamos null: ambos os módulos verificam o binário antes de invocar e
    // caem para o daemon HTTP via `plugin.httpClient` no caminho moderno.
    this.hierarchical = new HierarchicalProcessor(null, this.settings.hierarchicalThreshold);
    this.multiVector = new MultiVectorEmbedder(null, pluginDataPath);
    // v0.6.0 — ADR-018 Aegis-pattern HTTP daemon client (works on ALL devices: Mac+iOS uniform)
    // v1.4.1 — Prefer per-device cached URL (localStorage, NÃO sincronizado via iCloud).
    // Isso garante que cada device (Mac mini, MacBook, iPad, iPhone) use a URL que
    // funciona para ELE, mesmo que settings.zeusDaemonUrl (sincronizado) aponte para outro device.
    const _initialDaemonUrl = _zeusGetLocalDaemonUrl() || this.settings.zeusDaemonUrl;
    if (_initialDaemonUrl !== this.settings.zeusDaemonUrl) {
      console.log('[zeus] using per-device cached daemon URL:', _initialDaemonUrl, '(settings:', this.settings.zeusDaemonUrl, ')');
    }
    this.httpClient = new ZeusHttpClient(_initialDaemonUrl);

    // v1.5 — Daemon lifecycle: se 127.0.0.1:2223 não responder, plugin sobe
    // bin/ZeusDaemonMac sozinho (autonomia "drop-in" sem launchctl manual).
    // iOS: child_process indisponível → status `no-spawn`, plugin segue em modo
    // degradado read-only consumindo data/embeddings.jsonl syncado do Mac.
    this.daemonLifecycle = new DaemonLifecycle(this);
    if (isMac()) {
      // v1.6 — inicia FSEvents watcher para observability de iCloud sync. NÃO
      // dispara re-embed (codex HIGH #3 — vault.on já cobre); só mede latência
      // do adapter Obsidian vs FSEvents pra detectar quando o adapter perdeu sync.
      try {
        const ws = this.nativeWatcher.start();
        console.log('[zeus] native-watcher:', ws);
      } catch (e) {
        console.warn('[zeus] native-watcher start failed:', e.message);
      }
      try {
        const status = await this.daemonLifecycle.ensureRunning();
        console.log('[zeus] daemon lifecycle:', status);
        // v1.5.1 — fix P2 codex review: quando o lifecycle sobe (ou reaproveita)
        // um daemon local em 127.0.0.1:2223, redireciona httpClient pra ele,
        // sobrescrevendo qualquer cache de URL remota (Tailscale peer). Sem
        // esse rebase, plugin spawna localmente mas continua falando com peer
        // remoto — "drop-in/on-device" não cumprido.
        if (status && status.running && status.url && this.httpClient.baseUrl !== status.url) {
          console.log('[zeus] httpClient rebase:', this.httpClient.baseUrl, '→', status.url);
          this.httpClient.setBaseUrl(status.url);
          _zeusSetLocalDaemonUrl(status.url);
        }
      } catch (e) {
        console.warn('[zeus] daemon lifecycle ensureRunning failed:', e.message);
      }
    }

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
    // v1.4.2 — deviceId é PER-DEVICE: armazenado em localStorage (NÃO sincronizado via iCloud).
    // data.json sincronizado entre Mac mini, MacBook, iPad, iPhone — persistir deviceId lá
    // contaminaria todos os devices fazendo eles assumirem a identidade do último que escreveu.
    // localStorage é per-Obsidian-install, isolado por device.
    const ZEUS_LOCAL_DEVICE_ID_KEY = 'zeus.device.id';
    let _localDeviceId = null;
    try {
      if (typeof window !== 'undefined' && window.localStorage) {
        _localDeviceId = window.localStorage.getItem(ZEUS_LOCAL_DEVICE_ID_KEY);
      }
    } catch (_) {}
    if (!_localDeviceId) {
      _localDeviceId = this.coordinator.deviceId;  // generated by DistributedCoordinator
      try {
        if (typeof window !== 'undefined' && window.localStorage) {
          window.localStorage.setItem(ZEUS_LOCAL_DEVICE_ID_KEY, _localDeviceId);
        }
      } catch (_) {}
      console.log('[zeus] generated per-device deviceId (localStorage):', _localDeviceId);
    }
    // settings.deviceId fica em memória apenas — overrides do coordinator com o per-device.
    this.settings.deviceId = _localDeviceId;
    this.coordinator.deviceId = _localDeviceId;
    // IMPORTANTE: nunca persistir deviceId no data.json. Se já estiver lá (legado), limpar.
    if (_localDeviceId) {
      // Forçar deviceId vazio no que será salvo via loadData/saveSettings
      // Não chamamos saveSettings() aqui — settings.deviceId fica só em runtime.
    }
    // v0.10.0 — Background scheduler for stale-passport detection + claim-coordinated re-extract
    this.scheduler = new PassportScheduler(this, {
      intervalMs: this.settings.schedulerIntervalMs || 15 * 60 * 1000,
    });
    if (this.settings.schedulerEnabled) {
      this.scheduler.start();
    }

    // v0.6.1 — Adaptive daemon discovery (async, doesn't block onload)
    // v1.4.1 — Discovery agora valida/refresh em paralelo: se cache localStorage
    // está OK, isAvailable() responde rápido; se cache está stale, probes paralelos
    // encontram URL viável em <2s e atualizam o cache + httpClient para os próximos calls.
    this.app.workspace.onLayoutReady(async () => {
      try {
        // Primeiro: confirma se a URL atual (cache ou settings) responde. Se sim, evita re-probe.
        const currentOk = await this.httpClient.isAvailable(1500);
        let activeUrl = this.httpClient.baseUrl;
        if (!currentOk) {
          // URL atual morta — varre TAILSCALE_MESH + settings em paralelo.
          const discovered = await discoverDaemonUrl(this);
          if (discovered && discovered !== activeUrl) {
            console.log('[zeus] adapting daemon URL from', activeUrl, 'to', discovered);
            this.httpClient.setBaseUrl(discovered);
            activeUrl = discovered;
          }
        } else {
          // URL atual funciona — refresh do timestamp do cache (sliding TTL).
          _zeusSetLocalDaemonUrl(activeUrl);
        }
        // Probe daemon capabilities to log what's available
        const health = await this.httpClient.health();
        const tools = await this.httpClient.tools();
        console.log('[zeus] daemon health:', health.status, '| platform:', health.platform, '| endpoints:', (health.endpoints || []).length, '| tools:', tools.length, '| url:', activeUrl);
        if (health.status === 'ok') {
          const isLocal = _zeusIsLoopback(activeUrl);
          new Notice(`Zeus: daemon ${health.platform || '?'} ${isLocal ? 'LOCAL ✓' : 'REMOTE (Tailscale) ⚠'} · ${(health.endpoints || []).length} endpoints`);
        } else {
          // v1.4.1 — Instruções per-platform: cada device tem infra Apple nativa para rodar seu daemon.
          const macHint = 'macOS: rode `bash daemon/scripts/install-mac-daemon.sh` para subir o ZeusDaemonMac via LaunchAgent (~/Library/LaunchAgents/com.maiocchi.zeusdaemon.plist).';
          const iosHint = 'iOS: abra o app Aegis no device para iniciar o AegisDaemon (HTTP NIO em 127.0.0.1:2223, paridade total com macOS).';
          const platformHint = isMac() ? macHint : iosHint;
          new Notice(`Zeus: daemon UNREACHABLE em ${activeUrl}.\n${platformHint}\nOu desative "Permitir fallback remoto" para forçar modo strict on-device.`, 15000);
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
      name: 'Zeus: status do daemon HTTP (lifecycle)',
      callback: () => {
        const lc = this.daemonLifecycle;
        if (!lc) { new Notice('DaemonLifecycle não inicializado (iOS?)'); return; }
        const last = lc.lastStatus || { running: false, source: 'unknown' };
        const spawnedByUs = lc.spawnedByUs ? ' (spawned by plugin)' : '';
        new Notice(`Daemon ${last.running ? 'ALIVE' : 'DEAD'}: ${last.source}${spawnedByUs} · ${lc.url}`, 6000);
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

    // v2.0 — propaga pccMode para o HTTP client
    if (this.httpClient && typeof this.httpClient.setPccMode === 'function') {
      this.httpClient.setPccMode(this.settings.pccMode || 'off');
    }

    // v1.1 — refresh periódico do status bar com token-saved + PCC indicator.
    // Só atualiza quando o último estado foi 'idle' — evita sobrescrever indexing/embedding.
    const refreshMs = this.settings.statusBarRefreshIntervalMs || 30000;
    this._statusBarTimer = setInterval(() => {
      if (this._lastStatusBarState === 'idle' || !this._lastStatusBarState) {
        this.updateStatusBar('idle', null);
      }
    }, refreshMs);
    this.register(() => clearInterval(this._statusBarTimer));

    if (isMac() && this.settings.indexOnSave) {
      this.registerEvent(this.app.vault.on('modify', file => {
        if (file instanceof TFile) this.scheduleIncrementalIndex();
      }));
    }
    // v0.8.0 — native graph auto-resync on save (independent of indexOnSave/Mac)
    // v1.6.1 — codex MED #2: timer global era cancelado a cada modify, então só
    // a última nota dentro da janela 6s sincronizava. Map<path,timer> isola.
    if (this.settings.nativeGraphSyncOnSave) {
      this._graphSyncTimers = this._graphSyncTimers || new Map();
      this.registerEvent(this.app.vault.on('modify', file => {
        if (file instanceof TFile && file.extension === 'md') {
          const prev = this._graphSyncTimers.get(file.path);
          if (prev) clearTimeout(prev);
          const t = setTimeout(() => {
            this._graphSyncTimers.delete(file.path);
            this.nativeGraph.syncFile(file.path).catch(e => console.warn('[zeus] graph sync', e.message));
          }, 6000);
          this._graphSyncTimers.set(file.path, t);
        }
      }));
    }
    if (isMac() && this.settings.indexOnStartup) {
      this.app.workspace.onLayoutReady(() => {
        setTimeout(() => this.indexer.runFullIndex(msg => this.updateStatusBar('indexing', msg)), 3000);
      });
    }

    // v0.13.1 — Auto-open Smart View pane on plugin load (Smart Connections-style)
    // Only opens if no zeus-smart-view leaf already exists (respect user's preference)
    this.app.workspace.onLayoutReady(() => {
      setTimeout(() => {
        const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_SMART);
        if (existing.length === 0) {
          this.activateSmartView().catch(e => console.warn('[zeus] auto-open smart view failed:', e.message));
        }
      }, 1500);
    });

    // v0.13.2 — REAL-TIME indexação (Apple Notes-style)
    // NLContextualEmbedding via ANE: ~15ms por nota. Daemon overhead: ~5ms.
    // Total ~20-50ms imperceptível ao usuário.
    //
    // Pipeline em 2 estágios temporais:
    //   T+500ms (fast): embed via /v1/embed (instant cosine update)
    //   T+8s   (deep):  passport via afm enrich (FoundationModels reasoning)
    //
    // Eventos cobertos: modify, create, delete, rename (full coverage)
    this._embedTimers = new Map();
    this._passportTimers = new Map();
    this._audioTimers = new Map();   // v1.3.3 — real-time audio transcription

    const scheduleEmbed = (rel, file) => {
      clearTimeout(this._embedTimers.get(rel));
      this._embedTimers.set(rel, setTimeout(async () => {
        this._embedTimers.delete(rel);
        try {
          // Re-embed single file: read content, call daemon /v1/embed, update searcher.embeddings
          const content = await this.app.vault.read(file);
          const reachable = await this.httpClient.isAvailable();
          if (!reachable) return;
          const resp = await this.httpClient.embed(content.slice(0, 4000));
          if (resp && resp.vectors && resp.vectors[0]) {
            // Update in-memory + on-disk
            const sha = await universal.sha256Hex(content);
            const entry = { path: rel, sha, mtime: Date.now(), title: file.basename, vec: resp.vectors[0] };
            this.searcher.embeddings.set(rel, entry);
            this.indexer.saveEmbeddings(this.searcher.embeddings);
            this.refreshSmartView();
            console.log('[zeus] real-time embed:', rel, `dim=${resp.dim}`);
          }
        } catch (e) {
          console.warn('[zeus] real-time embed failed for', rel, e.message);
        }
      }, 500));   // 500ms debounce — Apple Notes-style instant
    };

    // v1.3.3 — real-time audio: VAD pre-filter → transcribe → embed
    // Debounce 2s (audio writes às vezes não são atômicos)
    const scheduleAudioTranscribe = (rel, file) => {
      if (!this.settings.indexOnSave) return;
      if (!this.settings.fileTypes || !this.settings.fileTypes[file.extension]) return;
      clearTimeout(this._audioTimers.get(rel));
      this._audioTimers.set(rel, setTimeout(async () => {
        this._audioTimers.delete(rel);
        try {
          const reachable = await this.httpClient.isAvailable();
          if (!reachable) return;

          // Resolver path absoluto (daemon precisa de path absoluto)
          let nodePath = null;
          try { nodePath = require('path'); } catch (_) { /* v1.4.2-ios: sandbox */ }
          const adapter = this.app.vault.adapter;
          const basePath = typeof adapter.getBasePath === 'function'
            ? adapter.getBasePath()
            : (adapter.basePath || '');
          const absPath = nodePath ? nodePath.join(basePath, rel) : basePath + '/' + rel;

          // VAD pre-filter (rápido — só duração)
          if (this.settings.audioVadEnabled) {
            const vad = await this.httpClient.aspVad(absPath);
            if (!vad || !vad.has_speech) {
              console.log('[zeus] audio skip (no speech):', rel,
                vad ? `${vad.duration_seconds.toFixed(1)}s < threshold` : 'vad failed');
              return;
            }
          }

          // Transcribe
          const locale = this.settings.audioLocale || 'pt-BR';
          const engine = this.settings.audioEngine || 'auto';
          const tr = await this.httpClient.aspTranscribe(absPath, locale, engine);
          if (!tr || !tr.text || tr.text.trim().length === 0) {
            console.log('[zeus] audio no transcript:', rel,
              tr ? `engine=${tr.engine_used}` : 'transcribe failed');
            return;
          }

          // Embed transcript
          const resp = await this.httpClient.embed(tr.text.slice(0, 4000));
          if (resp && resp.vectors && resp.vectors[0]) {
            const sha = await universal.sha256Hex(tr.text);
            const entry = {
              path: rel,
              sha,
              mtime: Date.now(),
              title: file.basename,
              vec: resp.vectors[0],
              // Audio-specific metadata (preserved no JSONL para Smart View)
              kind: 'audio',
              transcript: tr.text.slice(0, 1000),
              duration_seconds: tr.duration_seconds,
              audio_locale: tr.locale,
              audio_engine: tr.engine_used,
            };
            this.searcher.embeddings.set(rel, entry);
            this.indexer.saveEmbeddings(this.searcher.embeddings);
            this.refreshSmartView();
            console.log('[zeus] real-time audio:', rel,
              `${tr.duration_seconds.toFixed(1)}s · ${tr.text.length}ch · ${tr.engine_used}`);
          }
        } catch (e) {
          console.warn('[zeus] real-time audio failed for', rel, e.message);
        }
      }, 2000));  // 2s — audio writes podem não ser atômicos
    };

    const schedulePassport = (rel) => {
      if (!this.settings.schedulerEnabled) return;
      clearTimeout(this._passportTimers.get(rel));
      this._passportTimers.set(rel, setTimeout(async () => {
        this._passportTimers.delete(rel);
        try {
          const claim = await this.coordinator.claim(rel);
          if (!claim.claimed) return;
          try {
            await this.passport.buildOne(rel);
          } finally {
            await this.coordinator.release(rel);
          }
        } catch (e) {
          console.warn('[zeus] passport refresh failed for', rel, e.message);
        }
      }, 8000));   // 8s — deferred deep reasoning
    };

    // Event: modify (note edited)
    this.registerEvent(this.app.vault.on('modify', file => {
      if (!(file instanceof TFile)) return;
      if (file.extension === 'md') {
        scheduleEmbed(file.path, file);
        schedulePassport(file.path);
      } else if (AUDIO_EXTENSIONS.has(file.extension)) {
        scheduleAudioTranscribe(file.path, file);
      }
    }));

    // Event: create (new note)
    this.registerEvent(this.app.vault.on('create', file => {
      if (!(file instanceof TFile)) return;
      if (file.extension === 'md') {
        scheduleEmbed(file.path, file);
        schedulePassport(file.path);
      } else if (AUDIO_EXTENSIONS.has(file.extension)) {
        scheduleAudioTranscribe(file.path, file);
      }
    }));

    // Event: delete (purge entry)
    this.registerEvent(this.app.vault.on('delete', file => {
      if (!(file instanceof TFile)) return;
      this.searcher.embeddings.delete(file.path);
      this.indexer.saveEmbeddings(this.searcher.embeddings);
      this.refreshSmartView();
      console.log('[zeus] real-time delete:', file.path);
    }));

    // Event: rename (update path)
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (!(file instanceof TFile)) return;
      const entry = this.searcher.embeddings.get(oldPath);
      if (entry) {
        this.searcher.embeddings.delete(oldPath);
        entry.path = file.path;
        this.searcher.embeddings.set(file.path, entry);
        this.indexer.saveEmbeddings(this.searcher.embeddings);
        console.log('[zeus] real-time rename:', oldPath, '→', file.path);
      }
    }));

    // v1.6 — comandos novos: notas-irmãs híbridas, busca híbrida, graphify→FM, watcher status
    this.addCommand({
      id: 'zeus-sister-notes-hybrid',
      name: 'Zeus: notas irmãs (graph + semantic híbrido)',
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) { new Notice('Zeus: sem arquivo ativo'); return; }
        const n = new Notice('Zeus: calculando notas-irmãs (RRF semantic+graph+passport)…', 0);
        try {
          const hits = await this.hybrid.sisterNotes(file.path, 15);
          n.hide();
          if (!hits.length) { new Notice('Zeus: nenhuma nota-irmã encontrada'); return; }
          new ZeusHybridResultsModal(this.app, this, hits, `Notas-irmãs de ${file.basename}`).open();
        } catch (e) {
          n.hide();
          new Notice('Zeus sister falhou: ' + (e.message || String(e)).slice(0, 150));
        }
      },
    });
    this.addCommand({
      id: 'zeus-hybrid-search',
      name: 'Zeus: busca híbrida (graph + semantic + path)',
      callback: () => {
        try {
          new ZeusHybridSearchModal(this.app, this).open();
        } catch (e) {
          new Notice('Zeus hybrid-search falhou: ' + (e.message || String(e)).slice(0, 150));
        }
      },
    });
    this.addCommand({
      id: 'zeus-graphify-to-frontmatter',
      name: 'Zeus: graphify → frontmatter (integra ao graph nativo)',
      callback: async () => {
        const file = this.app.workspace.getActiveFile();
        if (!file) { new Notice('Zeus: sem arquivo ativo'); return; }
        const n = new Notice('Zeus: extraindo grafo (afm graph-extract) e escrevendo wikilinks…', 0);
        try {
          const r = await this.nativeGraph.syncFromGraphExtract(file.path);
          n.hide();
          if (r.ok) {
            new Notice(`Zeus graph→FM: ${r.count}/${r.nodes} entidades resolvidas e gravadas em zeus_graph_related`, 6000);
          } else if (r.skipped) {
            new Notice(`Zeus graph→FM: ${r.skipped}`, 5000);
          } else {
            new Notice(`Zeus graph→FM: ${r.error || 'erro desconhecido'}`, 6000);
          }
        } catch (e) {
          n.hide();
          new Notice('Zeus graphify falhou: ' + (e.message || String(e)).slice(0, 150));
        }
      },
    });
    // v1.7 — Spotlight CSSearchableIndex integration
    this.addCommand({
      id: 'zeus-spotlight-index',
      name: 'Zeus: indexar vault no Spotlight (CSSearchableIndex)',
      callback: async () => {
        try {
          if (!isMac()) { new Notice('Zeus Spotlight: apenas macOS'); return; }
          const n = new Notice('Zeus: montando lote de items para CSSearchableIndex…', 0);
          const files = this.app.vault.getMarkdownFiles();
          // Carrega passports em memória (1x) para enriquecer items.
          const passportMap = (this.passport && typeof this.passport.loadAll === 'function')
            ? await this.passport.loadAll().catch(() => new Map())
            : new Map();
          const items = [];
          for (const f of files) {
            const passport = passportMap.get(f.path) || null;
            const mtime = f.stat ? f.stat.mtime : Date.now();
            items.push({
              path: this.vaultRoot ? `${this.vaultRoot.replace(/\/$/, '')}/${f.path}` : f.path,
              title: f.basename,
              summary: (passport && (passport.one_line_summary || passport.summary)) || '',
              keywords: (passport && Array.isArray(passport.concepts)) ? passport.concepts.slice(0, 12) : [],
              mtime,
              modality: 'md',
            });
          }
          n.setMessage(`Zeus: enviando ${items.length} items para CSSearchableIndex…`);
          const r = await this.httpClient.spotlightIndex(items);
          n.hide();
          if (r.indexed != null) {
            new Notice(`Zeus Spotlight: ${r.indexed} items indexados · domain ${r.domain}`, 7000);
            try {
              const adapter = this.app.vault.adapter;
              const stateRel = universal.joinPath(this.manifest.dir, 'data', 'spotlight-state.json');
              await universal.adapterMkdir(adapter, universal.joinPath(this.manifest.dir, 'data'));
              await universal.adapterWriteAtomic(adapter, stateRel, JSON.stringify({
                last_indexed_at: new Date().toISOString(),
                count: r.indexed,
                domain: r.domain,
                mode: r.mode || 'queued',
              }, null, 2));
            } catch (e) { console.warn('[zeus] spotlight-state persist failed', e.message); }
          } else if (r.error && /CoreSpotlight indisponível|HTTP 404/.test(String(r.error))) {
            new Notice('Zeus Spotlight: daemon bundled v1.0 não suporta /v1/spotlight/index. Rebuild via `node scripts/build-release.mjs` para ativar.', 9000);
          } else {
            new Notice('Zeus Spotlight: ' + (r.error || JSON.stringify(r).slice(0, 200)), 8000);
          }
        } catch (e) {
          new Notice('Zeus Spotlight index falhou: ' + (e.message || String(e)).slice(0, 200), 8000);
        }
      },
    });

    this.addCommand({
      id: 'zeus-spotlight-purge',
      name: 'Zeus: purge índice Spotlight do vault',
      callback: async () => {
        try {
          if (!isMac()) { new Notice('Zeus Spotlight: apenas macOS'); return; }
          const r = await this.httpClient.spotlightPurge();
          if (r.purged) {
            new Notice(`Zeus Spotlight purged · domain ${r.domain}`, 5000);
          } else if (r.error && /CoreSpotlight indisponível|HTTP 404/.test(String(r.error))) {
            new Notice('Zeus Spotlight purge: daemon bundled v1.0 não suporta. Rebuild necessário.', 7000);
          } else {
            new Notice('Zeus Spotlight purge: ' + (r.error || 'erro'), 6000);
          }
        } catch (e) {
          new Notice('Zeus Spotlight purge falhou: ' + (e.message || String(e)).slice(0, 200), 7000);
        }
      },
    });

    this.addCommand({
      id: 'zeus-base-regenerate-rich',
      name: 'Zeus: regenerar .base enriquecido (v1.7 schema)',
      callback: async () => {
        try {
          const n = new Notice('Zeus: regenerando data/zeus-cards.base…', 0);
          const r = await this.basesGen.regenerate();
          n.hide();
          if (r.written) {
            const s = r.stats || {};
            new Notice(
              `Zeus .base: ${r.count} passports · summary=${s.withSummary || 0} · concepts=${s.withConcepts || 0} · domains=${(s.domainList || []).length}`,
              6000,
            );
          } else {
            new Notice('Zeus .base: data/passports.jsonl ausente — rode reindex primeiro', 6000);
          }
        } catch (e) {
          new Notice('Zeus base regen falhou: ' + (e.message || String(e)).slice(0, 200), 7000);
        }
      },
    });

    this.addCommand({
      id: 'zeus-native-watcher-status',
      name: 'Zeus: status do native-watcher (FSEvents iCloud)',
      callback: () => {
        try {
          if (!this.nativeWatcher) { new Notice('Zeus: native-watcher indisponível'); return; }
          const s = this.nativeWatcher.getStats();
          if (!s.running) { new Notice(`Zeus watcher OFF (iOS Capacitor ou fs.watch indisponível)`, 5000); return; }
          const hitRate = s.adapterHitRate != null ? `${(s.adapterHitRate * 100).toFixed(0)}%` : 'n/a';
          const ago = s.lastExternalAgoMs != null ? `${(s.lastExternalAgoMs / 1000).toFixed(0)}s` : 'never';
          new Notice(
            `Zeus watcher: ${s.externalEvents} ext events · adapter caught ${hitRate} · ${s.adapterMissed} missed · last ${ago}`,
            8000,
          );
        } catch (e) {
          new Notice('Zeus watcher-status falhou: ' + (e.message || String(e)).slice(0, 150));
        }
      },
    });

    console.log(`[zeus] loaded v${this.manifest.version} — Apple-native search & connections`);
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
    if (this.nativeWatcher) {
      try { this.nativeWatcher.stop(); } catch (e) { console.warn('[zeus] native-watcher stop:', e.message); }
    }
    if (this.daemonLifecycle) {
      try { await this.daemonLifecycle.stop(); } catch (e) { console.warn('[zeus] daemon lifecycle stop:', e.message); }
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
    // v1.4.2 — Strip device-specific keys from persisted settings (data.json sincroniza via iCloud).
    // deviceId fica em localStorage per-device; aqui filtramos antes de gravar.
    const { deviceId, ...persistable } = this.settings;
    await this.saveData(persistable);
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
  // v1.1 — Token-saved metrics + PCC indicator (auto-injetados no estado 'idle')
  updateStatusBar(state, info) {
    if (!this.statusBarEl) return;
    this._lastStatusBarState = state;
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
      // v1.1 — token-saved metrics
      if (this.settings.showTokenSavedInStatusBar && this.httpClient) {
        const saved = this._estimateTokensSaved();
        if (saved >= 100) text += ` · ${this._fmtTokens(saved)} saved`;
      }
      // v2.0 — PCC visual indicator
      if (this.settings.pccVisualIndicator && this.httpClient) {
        const pcc = this.httpClient.getPccStatus();
        if (pcc.mode !== 'off' && pcc.totalUsageCount > 0) {
          text += ` · ☁️PCC×${pcc.totalUsageCount}`;
        }
      }
    }
    this.statusBarEl.setText(text);
  }

  // v1.1 — Tokens economizados via PIA (Passport Index Architecture):
  // Cada request via daemon devolve um passport compacto (~300B) ao invés do
  // conteúdo bruto (~5KB médio). Estimativa: tokens_saved = (raw_baseline -
  // actual_tokens) por request, somado ao longo da sessão.
  _estimateTokensSaved() {
    if (!this.httpClient) return 0;
    const m = this.httpClient.getMetrics();
    const actualTokens = m.estimatedTokens || 0;
    const baseline = (this.settings.rawTokenBaseline || 1250) * m.requests;
    return Math.max(0, baseline - actualTokens);
  }

  _fmtTokens(n) {
    if (n < 1000) return `${n} tok`;
    if (n < 1e6) return `${(n / 1000).toFixed(1)}k tok`;
    return `${(n / 1e6).toFixed(2)}M tok`;
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
