/*
 * DistributedCoordinator — cross-device work claim/release via iCloud-synced lock files
 *
 * Pattern: arquivo de lock vive em <pluginDir>/data/claims/<sha256(notePath)>.lock,
 * sincroniza via iCloud (delay 5-30s aceitável dado TTL de 60s).
 * Conflito é raro e idempotente: se 2 devices indexarem a mesma nota
 * simultaneamente, ambos chegam ao mesmo SHA de output (deterministic Apple).
 *
 * Coordinator é universal Mac+iOS — usa Obsidian's vault.adapter (paths vault-relativos)
 * em vez de fs/path/os/crypto. Roda em qualquer device que carregue o plugin.
 *
 * Anti-conflict design:
 *   - Atomic write via tmp + rename (when adapter.rename exists)
 *   - TTL-based expiration (default 60s) — abandoned claims auto-release
 *   - Own-claim renew: re-acquire the same lock you already own
 *   - Last-writer-wins é OK: SHA-based diff é determinístico, content-equivalent
 *
 * v0.11 — universal (Mac+iOS) refactor: substituído fs/path/os/crypto top-level
 * por lib/universal-fs. Todos os métodos viraram async.
 */

'use strict';

const universal = require('./universal-fs');

const DEFAULT_TTL_MS = 60_000;
const CLAIMS_DIR_NAME = 'claims';

async function sha256Short(s) {
  const hex = await universal.sha256Hex(String(s));
  return hex.slice(0, 16);
}

class DistributedCoordinator {
  /**
   * @param {*} plugin Zeus plugin instance (uses plugin.app.vault.adapter + plugin.manifest.dir)
   * @param {{deviceId?: string, ttlMs?: number}} options
   */
  constructor(plugin, options = {}) {
    this.plugin = plugin;
    this.ttlMs = options.ttlMs || DEFAULT_TTL_MS;
    this.deviceId = options.deviceId || universal.generateDeviceId();
  }

  get _adapter() {
    return this.plugin.app.vault.adapter;
  }

  // Vault-relative path to the claims directory.
  get claimsDir() {
    return universal.joinPath(this.plugin.manifest.dir, 'data', CLAIMS_DIR_NAME);
  }

  async _ensureDir() {
    await universal.adapterMkdir(this._adapter, universal.joinPath(this.plugin.manifest.dir, 'data'));
    await universal.adapterMkdir(this._adapter, this.claimsDir);
  }

  async _lockPath(notePath) {
    const short = await sha256Short(notePath);
    return universal.joinPath(this.claimsDir, short + '.lock');
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
    await this._ensureDir();
    const lp = await this._lockPath(notePath);

    if (await universal.adapterExists(this._adapter, lp)) {
      try {
        const raw = await universal.adapterRead(this._adapter, lp);
        const existing = JSON.parse(raw);
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
    await universal.adapterWriteAtomic(this._adapter, lockPath, JSON.stringify(claim));
    return { claimed: true, ...claim };
  }

  /**
   * Release a claim previously acquired by this device. Returns:
   *   { released: true } on success
   *   { released: false, reason } if lock doesn't exist, owned by another device,
   *     or unreadable.
   */
  async release(notePath) {
    const lp = await this._lockPath(notePath);
    if (!(await universal.adapterExists(this._adapter, lp))) {
      return { released: false, reason: 'no lock' };
    }
    try {
      const raw = await universal.adapterRead(this._adapter, lp);
      const existing = JSON.parse(raw);
      if (existing.device_id !== this.deviceId) {
        return { released: false, reason: 'not owner', current_holder: existing.device_id };
      }
      await universal.adapterRemove(this._adapter, lp);
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
    await this._ensureDir();
    let cleaned = 0;
    const now = Date.now();
    const listing = await universal.adapterList(this._adapter, this.claimsDir);
    const entries = listing.files || [];
    for (const full of entries) {
      if (!full.endsWith('.lock')) continue;
      try {
        const raw = await universal.adapterRead(this._adapter, full);
        const claim = JSON.parse(raw);
        if (typeof claim.expires_at !== 'number' || claim.expires_at < now) {
          await universal.adapterRemove(this._adapter, full);
          cleaned++;
        }
      } catch {
        // Malformed — delete defensively.
        try { await universal.adapterRemove(this._adapter, full); cleaned++; } catch { /* ignore */ }
      }
    }
    return cleaned;
  }

  /**
   * Snapshot of active claims grouped by device.
   * Returns: { total, expired, byDevice: {<id>: count}, thisDeviceId }
   *
   * NOTE: this method is async (vault adapter is async). Callers must await.
   */
  async stats() {
    await this._ensureDir();
    const byDevice = new Map();
    let total = 0, expired = 0;
    const now = Date.now();
    const listing = await universal.adapterList(this._adapter, this.claimsDir);
    const entries = listing.files || [];
    for (const full of entries) {
      if (!full.endsWith('.lock')) continue;
      try {
        const raw = await universal.adapterRead(this._adapter, full);
        const claim = JSON.parse(raw);
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
