/*
 * PassportScheduler — background sweep que detecta notas com passport stale
 * (passport_sha != current_sha) e claima + re-extrai. Roda a cada N min (default 15).
 *
 * Lógica anti-duplicação:
 *   - Cada passport persistido tem `sha` (sha do conteúdo NO MOMENTO da extração).
 *   - Compare current_sha (do conteúdo atual em disco) vs persisted sha → diff means
 *     re-extract needed.
 *   - Tenta DistributedCoordinator.claim() → só prossegue se ganhou o lock.
 *   - Em sucesso: PassportIndex.buildOne() (que já persiste manifest + JSONL) +
 *     coordinator.release().
 *
 * Anti-conflict iCloud:
 *   - passports.jsonl é authoritative even after sync; sha-based diff é determinístico.
 *   - Two devices may both attempt — first claim wins, second sees claim e pula.
 *   - If both extract anyway (race in claim acquisition): same SHA → same output →
 *     idempotent (last-writer-wins é content-equivalent).
 *   - Initial sweep 30s after plugin load — let plugin settle, daemon health check,
 *     etc.
 *
 * Concurrency safety: re-entry-guarded via `this.running` flag. Concurrent sweep()
 * calls (e.g., manual trigger while auto-sweep in flight) become no-ops.
 *
 * v0.11 — universal Mac+iOS: substituído fs/crypto top-level por lib/universal-fs +
 * vault.adapter. Indexer.enumerateFiles agora retorna { abs, rel, ext } com rel relativo
 * ao vault — usamos rel para adapter reads.
 */

'use strict';

const universal = require('./universal-fs');

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000;          // 15 min
const INITIAL_DELAY_MS = 30 * 1000;                  // first sweep 30s after start

class PassportScheduler {
  /**
   * @param {*} plugin Zeus plugin instance (uses plugin.coordinator + plugin.indexer + plugin.passport)
   * @param {{intervalMs?: number}} options
   */
  constructor(plugin, options = {}) {
    this.plugin = plugin;
    this.intervalMs = options.intervalMs || DEFAULT_INTERVAL_MS;
    this.timerId = null;
    this.initialTimerId = null;
    this.lastSweep = null;
    this.running = false;
  }

  get coord() {
    return this.plugin.coordinator;
  }

  get _adapter() {
    return this.plugin.app.vault.adapter;
  }

  start() {
    if (this.timerId) return;
    this.timerId = setInterval(
      () => this.sweep().catch(e => console.warn('[zeus][scheduler] interval sweep:', e.message)),
      this.intervalMs,
    );
    console.log(`[zeus][scheduler] started — interval ${Math.round(this.intervalMs / 1000)}s`);
    // Initial sweep after a short delay (let plugin settle).
    this.initialTimerId = setTimeout(
      () => this.sweep().catch(e => console.warn('[zeus][scheduler] initial sweep:', e.message)),
      INITIAL_DELAY_MS,
    );
  }

  stop() {
    if (this.timerId) { clearInterval(this.timerId); this.timerId = null; }
    if (this.initialTimerId) { clearTimeout(this.initialTimerId); this.initialTimerId = null; }
  }

  /**
   * One sweep cycle: cleanup expired claims → walk vault → re-extract stale passports.
   * Re-entry safe (no-op if already running).
   *
   * Returns: { at, elapsed, claimed, skipped, extracted, errors, expiredCleaned }
   */
  async sweep() {
    if (this.running) {
      return { at: Date.now(), skipped: true, reason: 'already running' };
    }
    this.running = true;
    const start = Date.now();
    let claimed = 0, skipped = 0, extracted = 0, errors = 0, expiredCleaned = 0;

    try {
      if (!this.coord) {
        throw new Error('coordinator unavailable');
      }
      // Cleanup expired claims first (other devices may have crashed/abandoned).
      expiredCleaned = await this.coord.sweepExpired();

      // Enumerate markdown files via the indexer (respects folderExclusions/fileTypes).
      const files = (await this.plugin.indexer.enumerateFiles()).filter(f => f.ext === 'md');
      const passports = await this.plugin.passport.loadAll();

      for (const f of files) {
        let content;
        try {
          content = await universal.adapterRead(this._adapter, f.rel);
        } catch (e) {
          console.warn('[zeus][scheduler] read fail', f.rel, e.message);
          errors++;
          continue;
        }
        const currentSha = await universal.sha256Hex(content);
        const existing = passports.get(f.rel);

        // Already has passport for this exact SHA → skip cheap.
        if (existing && existing.sha === currentSha) {
          skipped++;
          continue;
        }

        // Stale (or missing) — try to claim.
        const claim = await this.coord.claim(f.rel);
        if (!claim.claimed) {
          skipped++;
          continue;
        }
        claimed++;

        try {
          await this.plugin.passport.buildOne(f.rel);
          extracted++;
        } catch (e) {
          console.warn('[zeus][scheduler] extract failed for', f.rel, e.message);
          errors++;
        } finally {
          try { await this.coord.release(f.rel); } catch { /* ignore */ }
        }
      }
    } catch (e) {
      console.warn('[zeus][scheduler] sweep error:', e.message);
      errors++;
    } finally {
      this.running = false;
      this.lastSweep = {
        at: Date.now(),
        elapsed: Date.now() - start,
        claimed,
        skipped,
        extracted,
        errors,
        expiredCleaned,
      };
    }
    return this.lastSweep;
  }

  /**
   * Quick status snapshot for status command / Settings tab.
   * NOTE: async — coord.stats() is async in v0.11.
   */
  async stats() {
    let coordStats = null;
    if (this.coord) {
      try { coordStats = await this.coord.stats(); } catch (e) {
        coordStats = { error: e.message };
      }
    }
    return {
      running: this.running,
      enabled: !!this.timerId,
      intervalMs: this.intervalMs,
      lastSweep: this.lastSweep,
      coordinator: coordStats,
    };
  }
}

module.exports = PassportScheduler;
