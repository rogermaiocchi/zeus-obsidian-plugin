/*
 * native-watcher.js — observabilidade de mudanças de arquivo via FSEvents do macOS.
 *
 * DESIGN: codex HIGH #3 alertou que duplicar o pipeline real-time do Obsidian
 * (vault.on('modify' | 'create' | 'delete' | 'rename')) com fs.watch e disparar
 * re-embed dois caminhos cria race entre `saveEmbeddings()` não-atômico.
 *
 * Por isso este módulo NÃO faz re-embedding. Ele só observa:
 *   - eventos de fs.watch(recursive:true) no vaultRoot (FSEvents nativo macOS)
 *   - dedup por arquivo + janela de quiet 1.5s (espera estabilidade pós-iCloud)
 *   - para cada arquivo finalmente estável, mede latência até vault.on('modify')
 *     disparar pelo Obsidian. Se Obsidian não viu em 5s, registra como "vault
 *     adapter perdeu sync" e expõe via comando para o usuário re-rodar reindex.
 *
 * Saída visível: comando "Zeus: status do native-watcher" exibe Notice com
 * (a) total de modificações externas detectadas na sessão,
 * (b) modificações que o Obsidian adapter perdeu (precisam de reindex),
 * (c) URL/PID do watcher.
 *
 * iOS Capacitor: sem child_process/fs.watch → módulo carrega mas .start() é no-op.
 */

'use strict';

const universal = require('./universal-fs');

const QUIET_MS = 1500;
const ADAPTER_DEADLINE_MS = 5000;
const MAX_TRACKED = 500;

class NativeWatcher {
  constructor(plugin) {
    this.plugin = plugin;
    this.watcher = null;
    this.running = false;
    // path → { lastSeenAt, timer, source }
    this._pending = new Map();
    // codex LOW #1: _adapterSeen criado no constructor para que o listener
    // vault.on('modify') registrado antes da inicialização funcione sem race.
    this._adapterSeen = new Map();
    // codex LOW #2: deadline timers rastreados para clearTimeout em stop().
    this._deadlineTimers = new Set();
    // Stats agregadas
    this.stats = {
      externalEvents: 0,
      adapterSawEvent: 0,
      adapterMissed: 0,
      missedPaths: [],
      lastExternalAt: 0,
    };
    // Listener Obsidian — registramos para confirmar latência adapter
    this._vaultListener = null;
  }

  start() {
    if (this.running) return { running: true, reason: 'already-running' };
    const fs = universal.nodeFs;
    if (!fs || !fs.watch) {
      return { running: false, reason: 'fs.watch indisponível (Capacitor/iOS)' };
    }
    const root = this.plugin.vaultRoot;
    if (!root) return { running: false, reason: 'no vaultRoot' };

    try {
      this.watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const rel = String(filename);
        if (!rel.endsWith('.md')) return;
        if (rel.includes('/.') || rel.startsWith('.')) return; // ignore .obsidian, .trash etc

        // Tracking de quiet window — múltiplos eventos do mesmo arquivo num
        // intervalo curto são tratados como UM evento estável.
        const prev = this._pending.get(rel);
        if (prev && prev.timer) clearTimeout(prev.timer);
        const entry = {
          lastSeenAt: Date.now(),
          source: eventType,
          timer: setTimeout(() => this._onStable(rel), QUIET_MS),
        };
        this._pending.set(rel, entry);

        // Cap memory: drop oldest entries
        if (this._pending.size > MAX_TRACKED) {
          const oldest = [...this._pending.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt)[0];
          if (oldest) {
            clearTimeout(oldest[1].timer);
            this._pending.delete(oldest[0]);
          }
        }
      });
    } catch (e) {
      return { running: false, reason: `fs.watch failed: ${e.message}` };
    }

    // Escuta vault.on('modify') para correlacionar e medir latência adapter.
    // registerEvent garante cleanup automático no onunload do plugin.
    try {
      const ref = this.plugin.app.vault.on('modify', (file) => {
        const seen = this._adapterSeen.get(file && file.path);
        if (seen) {
          this.stats.adapterSawEvent++;
          this._adapterSeen.delete(file.path);
        }
      });
      if (this.plugin.registerEvent) this.plugin.registerEvent(ref);
      this._vaultListener = ref;
    } catch (_) { /* registerEvent indisponível em testes */ }

    // _adapterSeen já criado no constructor (codex LOW #1)
    this.running = true;
    return { running: true, root, quietMs: QUIET_MS };
  }

  _onStable(rel) {
    this._pending.delete(rel);
    this.stats.externalEvents++;
    this.stats.lastExternalAt = Date.now();
    const deadline = Date.now() + ADAPTER_DEADLINE_MS;
    this._adapterSeen.set(rel, deadline);
    // codex LOW #2: cap _adapterSeen para não inchar com bursts.
    if (this._adapterSeen.size > MAX_TRACKED) {
      const oldest = [...this._adapterSeen.entries()].sort((a, b) => a[1] - b[1])[0];
      if (oldest) this._adapterSeen.delete(oldest[0]);
    }
    // codex LOW #2: armazena handle do timer pra clearTimeout em stop().
    const timer = setTimeout(() => {
      this._deadlineTimers.delete(timer);
      if (this._adapterSeen.has(rel)) {
        this.stats.adapterMissed++;
        this.stats.missedPaths.push({ path: rel, at: Date.now() });
        if (this.stats.missedPaths.length > 50) this.stats.missedPaths.shift();
        this._adapterSeen.delete(rel);
      }
    }, ADAPTER_DEADLINE_MS + 200);
    this._deadlineTimers.add(timer);
  }

  getStats() {
    const elapsed = this.stats.lastExternalAt ? (Date.now() - this.stats.lastExternalAt) : null;
    const hitRate = this.stats.externalEvents > 0
      ? (this.stats.adapterSawEvent / this.stats.externalEvents)
      : null;
    return {
      running: this.running,
      externalEvents: this.stats.externalEvents,
      adapterSawEvent: this.stats.adapterSawEvent,
      adapterMissed: this.stats.adapterMissed,
      missedPaths: this.stats.missedPaths.slice(-10),
      adapterHitRate: hitRate,
      lastExternalAgoMs: elapsed,
    };
  }

  stop() {
    if (this.watcher) {
      try { this.watcher.close(); } catch {}
      this.watcher = null;
    }
    for (const entry of this._pending.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this._pending.clear();
    // codex LOW #2: limpa também os deadline timers para que callbacks
    // pós-unload não toquem this.stats.
    for (const t of this._deadlineTimers) clearTimeout(t);
    this._deadlineTimers.clear();
    this._adapterSeen.clear();
    this.running = false;
  }
}

module.exports = NativeWatcher;
