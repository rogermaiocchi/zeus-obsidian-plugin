/*
 * daemon-lifecycle.js — auto-spawn do ZeusDaemonMac embarcado em bin/.
 *
 * Substitui o fluxo manual "rode install-mac-daemon.sh + launchctl" — o plugin
 * Obsidian, ao carregar no Mac, sobe o daemon HTTP sozinho usando o binário
 * em <plugin-dir>/bin/ZeusDaemonMac. iOS (Capacitor) pula porque não há
 * child_process; cai automaticamente para o modo degradado read-only.
 *
 * Ordem de resolução do daemon:
 *   1. /v1/health responde em http://127.0.0.1:2223 → reaproveita (LaunchAgent
 *      pré-existente do dev, ou outra instância). Não spawna nada.
 *   2. Spawna bin/ZeusDaemonMac em foreground (detached:false). O processo
 *      filho é amarrado ao Obsidian — sair do Obsidian mata o daemon.
 *   3. Polling em /v1/health por até 10s. Sucesso → registra como "spawnedByUs",
 *      lifecycle:stop chama SIGTERM → SIGKILL.
 *
 * Tolerância: se faltar binário, child_process, ou se port 2223 estiver
 * ocupado por outro processo, o módulo nunca lança — apenas retorna status
 * negativo. O plugin continua funcionando com httpClient apontando para uma
 * URL morta e degrada (resultados de busca semântica ficam vazios, mas o
 * Obsidian não trava).
 */

'use strict';

const BINARY_NAME = 'ZeusDaemonMac';
const DEFAULT_PORT = 2223;
const DEFAULT_HOST = '127.0.0.1';

class DaemonLifecycle {
  constructor(plugin, options = {}) {
    this.plugin = plugin;
    this.port = options.port || DEFAULT_PORT;
    this.host = options.host || DEFAULT_HOST;
    this.url = `http://${this.host}:${this.port}`;
    this.child = null;
    this.spawnedByUs = false;
    this.lastStatus = null;
  }

  _fs() { try { return require('fs'); } catch { return null; } }
  _path() { try { return require('path'); } catch { return null; } }
  _spawn() {
    try { return require('child_process').spawn; } catch { return null; }
  }
  _execFileSync() {
    try { return require('child_process').execFileSync; } catch { return null; }
  }

  binaryPath() {
    const fs = this._fs();
    const path = this._path();
    if (!fs || !path) return null;
    const vaultRoot = this.plugin.vaultRoot;
    if (!vaultRoot || !this.plugin.manifest || !this.plugin.manifest.dir) return null;
    const candidate = path.join(vaultRoot, this.plugin.manifest.dir, 'bin', BINARY_NAME);
    return fs.existsSync(candidate) ? candidate : null;
  }

  async isHealthy(timeoutMs = 1500) {
    const ZeusHttpClient = require('./zeus-http-client');
    const probe = new ZeusHttpClient(this.url);
    try { return await probe.isAvailable(timeoutMs); }
    catch { return false; }
  }

  // Garante que o binário tem +x e sem quarantena (Gatekeeper).
  // Idempotente — silencia falhas (codesign já é adhoc).
  _prepareBinary(absPath) {
    const fs = this._fs();
    if (fs) {
      try { fs.chmodSync(absPath, 0o755); } catch {}
    }
    const execFileSync = this._execFileSync();
    if (execFileSync) {
      try { execFileSync('/usr/bin/xattr', ['-d', 'com.apple.quarantine', absPath], { stdio: 'ignore' }); }
      catch {}
    }
  }

  async ensureRunning() {
    if (await this.isHealthy(800)) {
      this.lastStatus = { running: true, source: 'pre-existing', url: this.url };
      return this.lastStatus;
    }
    const spawn = this._spawn();
    if (!spawn) {
      this.lastStatus = { running: false, source: 'no-spawn', reason: 'child_process unavailable (Capacitor / iOS)' };
      return this.lastStatus;
    }
    const bin = this.binaryPath();
    if (!bin) {
      this.lastStatus = { running: false, source: 'no-binary', reason: `${BINARY_NAME} ausente em bin/` };
      return this.lastStatus;
    }

    this._prepareBinary(bin);

    return new Promise((resolve) => {
      let resolved = false;
      const finish = (status) => { if (!resolved) { resolved = true; this.lastStatus = status; resolve(status); } };

      let child;
      try {
        child = spawn(bin, ['--port', String(this.port), '--host', this.host], {
          stdio: 'ignore',
          detached: false,
          env: Object.assign({}, process.env || {}, { ZEUS_SPAWN_PARENT: 'obsidian' }),
        });
      } catch (e) {
        finish({ running: false, source: 'spawn-error', reason: e.message });
        return;
      }

      child.on('error', (err) => {
        finish({ running: false, source: 'spawn-error', reason: err.message });
      });
      child.on('exit', (code, signal) => {
        if (this.child === child) {
          this.child = null;
          this.spawnedByUs = false;
        }
        if (!resolved) finish({ running: false, source: 'spawn-exit', reason: `exit ${code} ${signal || ''}`.trim() });
      });

      this.child = child;
      this.spawnedByUs = true;

      const start = Date.now();
      const poll = async () => {
        if (resolved) return;
        if (await this.isHealthy(600)) {
          finish({ running: true, source: 'spawned', pid: child.pid, url: this.url, latencyMs: Date.now() - start });
          return;
        }
        if (Date.now() - start > 10000) {
          try { child.kill('SIGTERM'); } catch {}
          finish({ running: false, source: 'spawn-timeout', reason: 'sem /v1/health em 10s' });
          return;
        }
        setTimeout(poll, 300);
      };
      setTimeout(poll, 250);
    });
  }

  async stop({ graceMs = 2000 } = {}) {
    if (!this.spawnedByUs || !this.child) return { stopped: false, reason: 'not-spawned-by-us' };
    const child = this.child;
    this.child = null;
    this.spawnedByUs = false;
    try { child.kill('SIGTERM'); } catch {}
    await new Promise((r) => setTimeout(r, graceMs));
    try { child.kill('SIGKILL'); } catch {}
    return { stopped: true };
  }
}

module.exports = DaemonLifecycle;
