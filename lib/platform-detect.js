/*
 * platform-detect.js — v1.15.0 device autonomy: detecta plataforma, versão de OS
 * e capabilities nativas Apple (FoundationModels, AegisDaemon) para roteamento
 * autônomo por dispositivo.
 *
 * Baseado nos padrões de universal-fs.js (zero Node requires top-level).
 * Resultado cacheado em plugin.settings.deviceCapabilities (TTL 5min).
 *
 * Referência: v1.15.0 device autonomy (auditoria 2026-05-21).
 */

'use strict';

const universal = require('./universal-fs');

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 min

/**
 * Extrai versão semântica do iOS/macOS a partir do userAgent.
 * "iPhone OS 26_0_0" → "26.0.0"
 * "Mac OS X 14_3"    → "14.3"
 * @param {string} ua
 * @returns {string} versão ou "0.0"
 */
function parseOsVersion(ua) {
  if (!ua) return '0.0';
  // iOS: "iPhone OS 26_0" ou "CPU OS 17_4"
  let m = ua.match(/(?:iPhone OS|CPU OS)\s+([\d_]+)/i);
  if (m) return m[1].replace(/_/g, '.');
  // macOS via userAgent (Obsidian desktop Electron)
  m = ua.match(/Mac OS X\s+([\d_.]+)/i);
  if (m) return m[1].replace(/_/g, '.');
  return '0.0';
}

/**
 * Compara versão semântica "A.B.C" >= "X.Y.Z".
 * @param {string} ver
 * @param {string} min
 * @returns {boolean}
 */
function versionGte(ver, min) {
  const a = String(ver || '0').split('.').map(Number);
  const b = String(min || '0').split('.').map(Number);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] || 0, bi = b[i] || 0;
    if (ai > bi) return true;
    if (ai < bi) return false;
  }
  return true;
}

/**
 * Detecta platform a partir das APIs disponíveis.
 * Reutiliza universal.detectPlatform() como base.
 * @returns {{ platform: string, deviceClass: string, osVersion: string }}
 */
function detectPlatformInfo() {
  const platform = universal.detectPlatform(); // 'darwin'|'ios'|'ipados'|'unknown'
  let deviceClass = 'unknown';
  let osVersion = '0.0';

  if (platform === 'darwin') {
    deviceClass = 'mac';
    // macOS version via process.env ou userAgent
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    osVersion = parseOsVersion(ua);
    // process.env fallback para Electron que não expõe macOS no userAgent
    if (osVersion === '0.0' && typeof process !== 'undefined' && process.versions && process.versions.node) {
      // Electron no macOS — assume macOS moderno (14+) se node existe
      osVersion = '14.0';
    }
  } else if (platform === 'ipados') {
    deviceClass = 'ipad';
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    osVersion = parseOsVersion(ua);
  } else if (platform === 'ios') {
    deviceClass = 'iphone';
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    osVersion = parseOsVersion(ua);
  }

  return { platform, deviceClass, osVersion };
}

/**
 * Probe se o AegisDaemon está respondendo em 127.0.0.1:2223.
 * Reutiliza plugin.httpClient.isAvailable() com timeout curto.
 * @param {object} plugin
 * @param {number} [timeoutMs=1500]
 * @returns {Promise<{ aegisAvailable: boolean, fmAvailable: boolean|null }>}
 */
async function probeAegis(plugin, timeoutMs = 1500) {
  if (!plugin || !plugin.httpClient) return { aegisAvailable: false, fmAvailable: null };
  try {
    const available = await plugin.httpClient.isAvailable(timeoutMs);
    if (!available) return { aegisAvailable: false, fmAvailable: null };
    // Tenta ler /v1/health para saber se FM está disponível neste device
    let fmAvailable = null;
    try {
      const health = await plugin.httpClient.health();
      if (health && typeof health.fm_available === 'boolean') {
        fmAvailable = health.fm_available;
      }
    } catch (_) { /* health falhou mas daemon está vivo */ }
    return { aegisAvailable: true, fmAvailable };
  } catch (_) {
    return { aegisAvailable: false, fmAvailable: null };
  }
}

/**
 * Detecta e cacheia capabilities do device atual.
 * Cache TTL: 5 min (evita probes frequentes no startup).
 *
 * @param {object} plugin — ZeusPlugin com plugin.httpClient e plugin.settings
 * @returns {Promise<{
 *   platform: string,
 *   deviceClass: string,
 *   osVersion: string,
 *   aegisAvailable: boolean,
 *   fmAvailable: boolean|null,
 *   isMac: boolean,
 *   isIos: boolean,
 *   fmOnDevice: boolean,
 * }>}
 */
async function detectCapabilities(plugin) {
  // Verifica cache válido
  const cached = plugin && plugin.settings && plugin.settings.deviceCapabilities;
  if (cached && cached.last_detected) {
    const age = Date.now() - new Date(cached.last_detected).getTime();
    if (age < CACHE_TTL_MS && cached.detected_platform) {
      return _buildResult(cached);
    }
  }

  const { platform, deviceClass, osVersion } = detectPlatformInfo();
  const { aegisAvailable, fmAvailable } = await probeAegis(plugin);

  const caps = {
    detected_platform: platform,
    detected_os_version: osVersion,
    fm_available: fmAvailable,
    aegis_available: aegisAvailable,
    last_detected: new Date().toISOString(),
  };

  // Persiste no settings
  if (plugin && plugin.settings) {
    plugin.settings.deviceCapabilities = caps;
    // Não faz saveSettings() aqui — caller decide quando persistir
  }

  return _buildResult(caps);
}

function _buildResult(caps) {
  const platform = caps.detected_platform || 'unknown';
  const osVersion = caps.detected_os_version || '0.0';
  const isMac = platform === 'darwin';
  const isIos = platform === 'ios' || platform === 'ipados';
  // FoundationModels disponível: macOS 14+ OU iOS 26+ com Apple Intelligence
  const fmOnDevice = caps.fm_available === true ||
    (isMac && versionGte(osVersion, '14.0')) ||
    (isIos && versionGte(osVersion, '26.0') && caps.fm_available !== false);

  return {
    platform,
    deviceClass: isMac ? 'mac' : (platform === 'ipados' ? 'ipad' : (platform === 'ios' ? 'iphone' : 'unknown')),
    osVersion,
    aegisAvailable: caps.aegis_available === true,
    fmAvailable: caps.fm_available,
    isMac,
    isIos,
    fmOnDevice,
    // Conveniências para routing
    shouldUseLocalAegis: caps.aegis_available === true,
    shouldUseTranslation: isIos ? versionGte(osVersion, '17.4') : versionGte(osVersion, '14.0'),
    shouldUseNLContextualEmbedding: isIos ? versionGte(osVersion, '17.0') : true,
  };
}

module.exports = {
  detectCapabilities,
  detectPlatformInfo,
  probeAegis,
  versionGte,
  parseOsVersion,
};
