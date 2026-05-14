/*
 * universal-fs.js — Platform abstraction for Mac (Electron+Node) AND iOS (Capacitor sandbox).
 *
 * In iOS Obsidian, Node modules ('fs', 'path', 'child_process', 'crypto', 'os')
 * don't exist. Calling require('fs') at module top-level throws and prevents the
 * plugin from loading at all. This helper wraps every Node require in try/catch
 * and exposes universal equivalents based on:
 *   - Obsidian's vault.adapter API (platform-agnostic file I/O)
 *   - Web Crypto API (crypto.subtle.digest)
 *   - TextEncoder (UTF-8 byte length)
 *   - navigator.userAgent (platform detection)
 *
 * Module consumers should:
 *   1. Use vault.adapter for file operations (paths are vault-relative, forward-slash).
 *   2. Call universal.sha256Hex(text) instead of crypto.createHash().update().digest('hex').
 *   3. Call universal.byteLength(text) instead of Buffer.byteLength(text, 'utf8').
 *   4. Call universal.joinPath(...) instead of path.join(...).
 *   5. Call universal.detectPlatform() instead of reading process.platform.
 *   6. When child_process.spawn is ABSOLUTELY required (Mac-only daemons), import
 *      it lazily with `const cp = universal.nodeChildProcess` and null-check.
 *
 * Reference: v0.11 universal Mac+iOS compatibility refactor (2026-05-14).
 */

'use strict';

let nodeFs = null;
let nodePath = null;
let nodeCrypto = null;
let nodeOs = null;
let nodeChildProcess = null;

try { nodeFs = require('fs'); } catch (_) { /* iOS sandbox */ }
try { nodePath = require('path'); } catch (_) { /* iOS sandbox */ }
try { nodeCrypto = require('crypto'); } catch (_) { /* iOS sandbox */ }
try { nodeOs = require('os'); } catch (_) { /* iOS sandbox */ }
try { nodeChildProcess = require('child_process'); } catch (_) { /* iOS sandbox */ }

const IS_NODE = !!nodeFs;

// ---------------------------------------------------------------------------
// Hashing — SHA-256 hex digest
// ---------------------------------------------------------------------------
// In Node: synchronous via crypto.createHash. In browser/iOS: async Web Crypto.
// We expose a single ASYNC API so callers don't branch — always await.
async function sha256Hex(input) {
  if (nodeCrypto && typeof nodeCrypto.createHash === 'function') {
    return nodeCrypto.createHash('sha256').update(String(input)).digest('hex');
  }
  // Browser / iOS: Web Crypto SubtleCrypto
  if (typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function') {
    const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
    const buf = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(buf))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }
  throw new Error('universal-fs: no SHA-256 implementation available');
}

// Synchronous variant — Node only. Used by tight loops that can't await.
// On iOS this returns null (caller must fall back to async sha256Hex).
function sha256HexSync(input) {
  if (nodeCrypto && typeof nodeCrypto.createHash === 'function') {
    return nodeCrypto.createHash('sha256').update(String(input)).digest('hex');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Path manipulation — vault-relative forward-slash convention
// ---------------------------------------------------------------------------
function joinPath(...parts) {
  return parts
    .filter(p => p !== null && p !== undefined && p !== '')
    .map(p => String(p))
    .join('/')
    .replace(/\/+/g, '/');
}

function dirname(p) {
  if (!p) return '';
  const s = String(p).replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i < 0 ? '' : s.slice(0, i);
}

function basename(p) {
  if (!p) return '';
  const s = String(p).replace(/\/+$/, '');
  const i = s.lastIndexOf('/');
  return i < 0 ? s : s.slice(i + 1);
}

function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i);
}

// ---------------------------------------------------------------------------
// Byte length — UTF-8
// ---------------------------------------------------------------------------
function byteLength(s) {
  if (s == null) return 0;
  if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') {
    return Buffer.byteLength(String(s), 'utf8');
  }
  if (typeof TextEncoder !== 'undefined') {
    return new TextEncoder().encode(String(s)).length;
  }
  return String(s).length; // very rough fallback
}

// ---------------------------------------------------------------------------
// Platform detection — does NOT rely on process.platform (absent in iOS)
// ---------------------------------------------------------------------------
function detectPlatform() {
  if (typeof process !== 'undefined' && process.platform) {
    return process.platform; // 'darwin', 'win32', 'linux', etc.
  }
  if (typeof navigator !== 'undefined' && navigator.userAgent) {
    const ua = navigator.userAgent;
    if (/iPad/i.test(ua)) return 'ipados';
    if (/iPhone|iPod/i.test(ua)) return 'ios';
    if (/Macintosh|Mac OS X/i.test(ua)) return 'darwin';
    if (/Android/i.test(ua)) return 'android';
    if (/Windows/i.test(ua)) return 'win32';
    if (/Linux/i.test(ua)) return 'linux';
  }
  return 'unknown';
}

function isMacLike() {
  const p = detectPlatform();
  return p === 'darwin';
}

function isMobile() {
  const p = detectPlatform();
  return p === 'ios' || p === 'ipados' || p === 'android';
}

// ---------------------------------------------------------------------------
// Stable device id — replacement for os.hostname() heuristic
// ---------------------------------------------------------------------------
function generateDeviceId() {
  const platform = detectPlatform();
  let hint = 'dev';
  try {
    if (nodeOs && typeof nodeOs.hostname === 'function') {
      hint = String(nodeOs.hostname()).replace(/[^a-z0-9-]/gi, '').slice(0, 12) || 'dev';
    } else if (typeof navigator !== 'undefined') {
      // Use a stable fragment from userAgent so deviceId doesn't drift each restart.
      const ua = String(navigator.userAgent || '');
      const m = ua.match(/(iPhone|iPad|iPod|Mac|Win|Linux|Android)[^\s;)]*/i);
      if (m) hint = m[0].replace(/[^a-z0-9-]/gi, '').slice(0, 12);
    }
  } catch (_) { /* ignore */ }
  const rand = Math.random().toString(36).slice(2, 8);
  const ts = Date.now().toString(36).slice(-4);
  return `${platform}-${hint}-${ts}-${rand}`;
}

// ---------------------------------------------------------------------------
// Vault adapter helpers — convenience wrappers that take an adapter argument.
// Each method returns a promise. Callers pass `plugin.app.vault.adapter`.
// ---------------------------------------------------------------------------
async function adapterRead(adapter, vaultRelPath) {
  return await adapter.read(vaultRelPath);
}

async function adapterReadBinary(adapter, vaultRelPath) {
  if (typeof adapter.readBinary === 'function') return await adapter.readBinary(vaultRelPath);
  // Fallback: read as text (may corrupt binary; caller should know).
  return await adapter.read(vaultRelPath);
}

async function adapterWrite(adapter, vaultRelPath, data) {
  // Ensure parent dir exists for nested writes.
  const parent = dirname(vaultRelPath);
  if (parent) {
    try { await adapter.mkdir(parent); } catch (_) { /* mkdir is idempotent in Obsidian */ }
  }
  return await adapter.write(vaultRelPath, data);
}

async function adapterExists(adapter, vaultRelPath) {
  try { return await adapter.exists(vaultRelPath); }
  catch (_) { return false; }
}

async function adapterMkdir(adapter, vaultRelPath) {
  try { return await adapter.mkdir(vaultRelPath); }
  catch (_) { /* idempotent */ }
}

async function adapterRemove(adapter, vaultRelPath) {
  try { return await adapter.remove(vaultRelPath); }
  catch (_) { /* gone is fine */ }
}

async function adapterStat(adapter, vaultRelPath) {
  try { return await adapter.stat(vaultRelPath); }
  catch (_) { return null; }
}

async function adapterList(adapter, vaultRelPath) {
  try { return await adapter.list(vaultRelPath); }
  catch (_) { return { files: [], folders: [] }; }
}

/**
 * Recursively enumerate ALL files under a vault-relative folder.
 * Returns an array of vault-relative paths (forward-slash).
 * Skips entries whose basename starts with '.' OR is in skipNames.
 */
async function adapterWalk(adapter, rootRel, skipNames = new Set()) {
  const out = [];
  const queue = [rootRel || ''];
  while (queue.length) {
    const dir = queue.shift();
    const { files, folders } = await adapterList(adapter, dir);
    for (const f of files || []) {
      const name = basename(f);
      if (skipNames.has(name)) continue;
      out.push(f);
    }
    for (const sub of folders || []) {
      const name = basename(sub);
      if (name && name.startsWith('.')) continue;
      if (skipNames.has(name)) continue;
      queue.push(sub);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Atomic write — try tmp+rename when available, else direct write.
// Vault adapter doesn't expose rename atomicity; we approximate.
// ---------------------------------------------------------------------------
async function adapterWriteAtomic(adapter, vaultRelPath, data) {
  const tmp = vaultRelPath + '.tmp';
  await adapterWrite(adapter, tmp, data);
  // adapter.rename is available on Obsidian Desktop/Mobile vault adapters.
  if (typeof adapter.rename === 'function') {
    try {
      // remove existing target first (rename fails if dest exists on some adapters)
      try { await adapter.remove(vaultRelPath); } catch (_) {}
      await adapter.rename(tmp, vaultRelPath);
      return;
    } catch (_) { /* fall through to non-atomic write */ }
  }
  await adapterWrite(adapter, vaultRelPath, data);
  try { await adapter.remove(tmp); } catch (_) {}
}

module.exports = {
  IS_NODE,
  // hashing
  sha256Hex,
  sha256HexSync,
  // paths
  joinPath,
  dirname,
  basename,
  extname,
  // misc
  byteLength,
  detectPlatform,
  isMacLike,
  isMobile,
  generateDeviceId,
  // vault adapter helpers
  adapterRead,
  adapterReadBinary,
  adapterWrite,
  adapterWriteAtomic,
  adapterExists,
  adapterMkdir,
  adapterRemove,
  adapterStat,
  adapterList,
  adapterWalk,
  // node escape hatches — null on iOS
  nodeFs,
  nodePath,
  nodeCrypto,
  nodeOs,
  nodeChildProcess,
};
