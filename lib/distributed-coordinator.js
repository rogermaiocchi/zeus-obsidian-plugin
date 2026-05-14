/*
 * DistributedCoordinator — cross-device work claim/release via iCloud-synced lock files
 *
 * Pattern: arquivo de lock vive em data/claims/<sha256(notePath)>.lock,
 * sincroniza via iCloud (delay 5-30s aceitável dado TTL de 60s).
 * Conflito é raro e idempotente: se 2 devices indexarem a mesma nota
 * simultaneamente, ambos chegam ao mesmo SHA de output (deterministic Apple).
 *
 * Coordinator NÃO faz HTTP — usa filesystem direto (mais rápido que daemon round-trip
 * e funciona offline). Daemon /v1/passport/claim é wrapper opcional para chamadas
 * de agents externos que falem REST.
 *
 * Anti-conflict design:
 *   - Atomic write via tmp + rename
 *   - TTL-based expiration (default 60s) — abandoned claims auto-release
 *   - Own-claim renew: re-acquire the same lock you already own
 *   - Last-writer-wins é OK: SHA-based diff é determinístico, content-equivalent
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const DEFAULT_TTL_MS = 60_000;
const CLAIMS_DIR_NAME = 'claims';

function sha256Short(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
}

class DistributedCoordinator {
  /**
   * @param {*} plugin Zeus plugin instance (uses plugin.vaultRoot + plugin.manifest.dir)
   * @param {{deviceId?: string, ttlMs?: number}} options
   */
  constructor(plugin, options = {}) {
    this.plugin = plugin;
    this.ttlMs = options.ttlMs || DEFAULT_TTL_MS;
    this.deviceId = options.deviceId || this._generateDeviceId();
  }

  _generateDeviceId() {
    let hostname = 'unknown';
    try {
      if (typeof os.hostname === 'function') hostname = os.hostname() || 'unknown';
    } catch { /* ignore */ }
    const platform = process.platform || 'unknown';
    const rand = Math.random().toString(36).slice(2, 8);
    const cleanHost = String(hostname).replace(/[^a-z0-9-]/gi, '').slice(0, 12) || 'host';
    return `${platform}-${cleanHost}-${rand}`;
  }

  get claimsDir() {
    return path.join(
      this.plugin.vaultRoot,
      this.plugin.manifest.dir,
      'data',
      CLAIMS_DIR_NAME,
    );
  }

  _ensureDir() {
    try { fs.mkdirSync(this.claimsDir, { recursive: true }); } catch { /* ignore */ }
  }

  _hashPath(notePath) {
    return sha256Short(notePath);
  }

  _lockPath(notePath) {
    return path.join(this.claimsDir, this._hashPath(notePath) + '.lock');
  }

  /**
   * Try to acquire a claim on `notePath`. Returns { claimed: true, ...claim } on
   * success, or { claimed: false, current_holder, expires_at } if held by another
   * device whose claim hasn't yet expired.
   *
   * If the existing lock is owned by THIS device, the claim is renewed (TTL extended).
   * If the existing lock is expired or malformed, it's overwritten.
   */
  async claim(notePath) {
    this._ensureDir();
    const lp = this._lockPath(notePath);

    if (fs.existsSync(lp)) {
      try {
        const existing = JSON.parse(fs.readFileSync(lp, 'utf8'));
        const now = Date.now();
        if (existing && typeof existing.expires_at === 'number' && existing.expires_at > now) {
          if (existing.device_id === this.deviceId) {
            // Own claim — renew (extend TTL).
            return await this._writeClaimAtomic(notePath, lp);
          }
          // Held by another device.
          return {
            claimed: false,
            current_holder: existing.device_id,
            expires_at: existing.expires_at,
            note_path: notePath,
          };
        }
        // Expired — fall through and overwrite.
      } catch (e) {
        console.warn('[zeus][coord] malformed lock, overwriting:', e.message);
      }
    }
    return await this._writeClaimAtomic(notePath, lp);
  }

  async _writeClaimAtomic(notePath, lockPath) {
    const now = Date.now();
    const claim = {
      device_id: this.deviceId,
      note_path: notePath,
      claimed_at: now,
      expires_at: now + this.ttlMs,
    };
    const tmp = lockPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(claim));
    fs.renameSync(tmp, lockPath);
    return { claimed: true, ...claim };
  }

  /**
   * Release a claim previously acquired by this device. Returns:
   *   { released: true } on success
   *   { released: false, reason } if lock doesn't exist, owned by another device,
   *     or unreadable.
   */
  async release(notePath) {
    const lp = this._lockPath(notePath);
    if (!fs.existsSync(lp)) return { released: false, reason: 'no lock' };
    try {
      const existing = JSON.parse(fs.readFileSync(lp, 'utf8'));
      if (existing.device_id !== this.deviceId) {
        return { released: false, reason: 'not owner', current_holder: existing.device_id };
      }
      fs.unlinkSync(lp);
      return { released: true };
    } catch (e) {
      return { released: false, reason: e.message };
    }
  }

  /**
   * Sweep all expired locks. Returns count of removed locks (including
   * malformed ones, which are treated as expired).
   */
  async sweepExpired() {
    this._ensureDir();
    let cleaned = 0;
    const now = Date.now();
    let entries;
    try { entries = fs.readdirSync(this.claimsDir); } catch { return 0; }
    for (const entry of entries) {
      if (!entry.endsWith('.lock')) continue;
      const full = path.join(this.claimsDir, entry);
      try {
        const claim = JSON.parse(fs.readFileSync(full, 'utf8'));
        if (typeof claim.expires_at !== 'number' || claim.expires_at < now) {
          fs.unlinkSync(full);
          cleaned++;
        }
      } catch {
        // Malformed — delete defensively.
        try { fs.unlinkSync(full); cleaned++; } catch { /* ignore */ }
      }
    }
    return cleaned;
  }

  /**
   * Snapshot of active claims grouped by device.
   * Returns: { total, expired, byDevice: {<id>: count}, thisDeviceId }
   */
  stats() {
    this._ensureDir();
    const byDevice = new Map();
    let total = 0, expired = 0;
    const now = Date.now();
    let entries;
    try { entries = fs.readdirSync(this.claimsDir); } catch { entries = []; }
    for (const entry of entries) {
      if (!entry.endsWith('.lock')) continue;
      try {
        const claim = JSON.parse(fs.readFileSync(path.join(this.claimsDir, entry), 'utf8'));
        total++;
        if (typeof claim.expires_at !== 'number' || claim.expires_at < now) expired++;
        const dev = claim.device_id || 'unknown';
        byDevice.set(dev, (byDevice.get(dev) || 0) + 1);
      } catch { /* ignore */ }
    }
    return {
      total,
      expired,
      byDevice: Object.fromEntries(byDevice),
      thisDeviceId: this.deviceId,
    };
  }
}

module.exports = DistributedCoordinator;
