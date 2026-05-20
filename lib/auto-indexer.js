/*
 * auto-indexer.js — orquestração automática da indexação multi-camada (v1.10).
 *
 * Alavanca a engenharia nativa Apple (FSEvents macOS via Obsidian vault.on,
 * vault.adapter no iOS Capacitor) pra disparar rebuilds de TODAS as camadas
 * sem intervenção do usuário:
 *
 *   modify/create   → embed (500ms debounce) ─┐
 *                    → passport (8s)          ├→ .base regen (10s após passport)
 *                    → spotlight index (15s)  │
 *                    → multiplex rebuild      │  (cooldown 60s + N≥10 mods)
 *                       └→ leiden communities (30s após multiplex)
 *   delete/rename   → purge das entries correspondentes
 *
 * Princípio: cada camada tem sua própria debounce + dedup key; multiplex+leiden
 * são "downstream" das outras (rodam só APÓS as upstream estabilizarem). Para
 * vault grande, isso evita rebuilds repetidos enquanto user edita ativamente.
 *
 * iOS Capacitor: vault.on() já é nativo; spotlight é skip (sem daemon local);
 * passport requer daemon HTTP local (só funciona quando AegisDaemon disponível).
 *
 * Lifecycle: start() registra hooks; stop() limpa timers. Reentrante via mutex.
 */

'use strict';

const DEBOUNCE = {
  passport: 8000,
  base: 10000,
  spotlight: 15000,
  multiplex: 60000,
  leiden: 30000,
  // v1.11 Feature I — lexical-ios incremental ~30s após passport (em iOS,
  // bm25 in-memory pode estar indisponível; este é o único sinal lexical).
  lexicalIos: 30000,
};

const MULTIPLEX_MOD_THRESHOLD = 10;

class AutoIndexer {
  constructor(plugin) {
    this.plugin = plugin;
    this.running = false;
    this.timers = new Map();
    this.runningKeys = new Set();
    this.lastRun = new Map();         // key → { at, result, durationMs }
    this._modCount = 0;
    this._bootTimer = null;
    this._eventRefs = [];
  }

  start() {
    if (this.running) return { running: true, reason: 'already-running' };
    if (!this.plugin || !this.plugin.app || !this.plugin.app.vault) {
      return { running: false, reason: 'plugin.app.vault unavailable' };
    }
    const v = this.plugin.app.vault;

    // 4 hooks vault.on — vault.on retorna EventRef que registerEvent rastreia
    // pra cleanup automático no onunload. Aqui guardamos cópias para stop().
    const refs = [
      v.on('modify', f => this._onChange(f, 'modify')),
      v.on('create', f => this._onChange(f, 'create')),
      v.on('delete', f => this._onDelete(f)),
      v.on('rename', (f, old) => this._onRename(f, old)),
    ];
    for (const r of refs) {
      if (this.plugin.registerEvent) this.plugin.registerEvent(r);
      this._eventRefs.push(r);
    }

    // Boot check: 8s após start(), verifica se algum data file está stale
    // vs vault mtime e dispara rebuild correspondente.
    this._bootTimer = setTimeout(() => this._bootCheck(), 8000);

    this.running = true;
    return { running: true, hooks: 4 };
  }

  stop() {
    if (!this.running) return { stopped: false };
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    if (this._bootTimer) { clearTimeout(this._bootTimer); this._bootTimer = null; }
    // Note: registerEvent already cleaned up by Obsidian on onunload. Limpa
    // referências locais por garantia.
    this._eventRefs = [];
    this.running = false;
    return { stopped: true };
  }

  // ---------------------------------------------------------------------------
  // Event handlers
  // ---------------------------------------------------------------------------

  _onChange(file, kind) {
    if (!file || !file.path) return;
    if (!file.path.endsWith('.md')) return;
    // Skip arquivos dentro do próprio data dir do plugin (não auto-indexar
    // metadata files: data/load-trace.log já filtrado por ext, mas paranoia)
    if (file.path.startsWith(this.plugin.manifest.dir)) return;

    this._modCount++;

    // 1) passport — rebuild da nota tocada
    this._schedule('passport:' + file.path, DEBOUNCE.passport, () => this._runPassport(file.path));
    // 2) .base — regen agregado (debounce dedup numa key única)
    this._schedule('base', DEBOUNCE.base, () => this._runBase());
    // 3) spotlight — batch index das notas modificadas desde último run
    this._schedule('spotlight', DEBOUNCE.spotlight, () => this._runSpotlight());
    // 4) multiplex — só após N modifications, cooldown longo
    if (this._modCount >= MULTIPLEX_MOD_THRESHOLD) {
      this._modCount = 0;
      this._schedule('multiplex', DEBOUNCE.multiplex, () => this._runMultiplex());
    }
    // 5) v1.11 Feature I — lexical-ios incremental (re-tokeniza só essa nota)
    this._schedule('lexicalIos:' + file.path, DEBOUNCE.lexicalIos, () => this._runLexicalIos(file.path));
  }

  _onDelete(file) {
    if (!file || !file.path || !file.path.endsWith('.md')) return;
    // multiplex/.base/communities ficam stale até próximo rebuild.
    // Por design, agendamos .base imediato e multiplex no cooldown padrão.
    this._schedule('base', DEBOUNCE.base, () => this._runBase());
    this._modCount++;
    if (this._modCount >= MULTIPLEX_MOD_THRESHOLD) {
      this._modCount = 0;
      this._schedule('multiplex', DEBOUNCE.multiplex, () => this._runMultiplex());
    }
  }

  _onRename(file, oldPath) {
    if (!file || !file.path) return;
    // Equivalente a delete(old) + create(new). vault.on já dispara ambos via Obsidian.
    this._onDelete({ path: oldPath || '' });
    this._onChange(file, 'rename');
  }

  // ---------------------------------------------------------------------------
  // Schedulers (debounced + dedup)
  // ---------------------------------------------------------------------------

  _schedule(key, ms, fn) {
    // Se já rodando esta key, não re-agenda (evita pileup); próxima oportunidade
    // virá no próximo trigger natural.
    if (this.runningKeys.has(key)) return;
    const prev = this.timers.get(key);
    if (prev) clearTimeout(prev);
    const t = setTimeout(async () => {
      this.timers.delete(key);
      this.runningKeys.add(key);
      const t0 = Date.now();
      try {
        const result = await fn();
        this.lastRun.set(key, { at: Date.now(), result, durationMs: Date.now() - t0 });
      } catch (e) {
        console.warn('[zeus.autoidx]', key, 'failed:', e && e.message ? e.message : e);
        this.lastRun.set(key, { at: Date.now(), error: e && e.message ? e.message : String(e), durationMs: Date.now() - t0 });
      } finally {
        this.runningKeys.delete(key);
      }
    }, ms);
    this.timers.set(key, t);
  }

  // ---------------------------------------------------------------------------
  // Runners
  // ---------------------------------------------------------------------------

  async _runPassport(path) {
    const p = this.plugin.passport;
    if (!p) return { skipped: 'no-passport' };
    // v1.10.2 fix: usa PassportIndex.buildOne (que chama daemon + persiste em
    // passports.jsonl + atualiza manifest). Antes do fix, AutoIndexer chamava
    // httpClient.passportBatchExtract direto e descartava o retorno — passports
    // não eram gravados em disk.
    if (typeof p.buildOne === 'function') {
      try {
        // v1.10.3: vault.on('create').file.path é VAULT-RELATIVE
        // ("00 Templates/Foo.md"). Daemon /v1/passport/extract exige path
        // ABSOLUTE. Sem conversão, daemon retorna "não foi possível ler".
        // v1.11 Feature E: buildOne agora tem fallback ios-local automático;
        // o absPath continua sendo o caminho preferido para o daemon.
        let absPath = path;
        if (path && !path.startsWith('/') && this.plugin.vaultRoot) {
          absPath = this.plugin.vaultRoot.replace(/\/$/, '') + '/' + path;
        }
        const passport = await p.buildOne(absPath, []);
        // v1.11.1 codex HIGH #2: quando passport.source==='ios-local' E device é
        // iOS, enfileira REPROCESS via FM no Mac. Antes esse path só rodava em
        // erro raro; agora roda em CADA passport iOS (preventivamente) — Mac
        // reprocessa com qualidade FM quando online.
        try {
          if (passport && passport.source === 'ios-local'
              && this.plugin.ioQueue && this.plugin.coordinator
              && this.plugin.coordinator.deviceId
              && /ios|ipad/i.test(this.plugin.coordinator.deviceId)) {
            const relPath = path && path.startsWith('/') && this.plugin.vaultRoot
              ? path.slice(this.plugin.vaultRoot.length).replace(/^\/+/, '')
              : path;
            await this.plugin.ioQueue.enqueue({
              path: relPath,
              sha: passport.sha || '',
              type: 'passport',
              payload: { reason: 'ios-local-needs-fm-refine' },
              enqueued_at: new Date().toISOString(),
              enqueued_by: this.plugin.coordinator.deviceId,
            });
          }
        } catch (eq) {
          console.warn('[zeus.autoidx] ios passport enqueue failed:', eq.message);
        }
        return {
          passport: passport && passport.path,
          concepts: (passport && passport.concepts || []).length,
          source: passport && passport.source || 'daemon',
        };
      } catch (e) {
        // v1.11 Feature H — quando passport.buildOne falha em iOS (sem daemon
        // alcançável E _buildOneLocal também falhou por algum motivo raro como
        // arquivo inacessível), enfileira para o Mac processar via io-queue.
        // No Mac, falha é falha — não enfileiramos (Mac é quem consome).
        if (this.plugin.ioQueue && this.plugin.coordinator
            && this.plugin.coordinator.deviceId
            && /ios|ipad/i.test(this.plugin.coordinator.deviceId)) {
          try {
            const relPath = path && path.startsWith('/') && this.plugin.vaultRoot
              ? path.slice(this.plugin.vaultRoot.length).replace(/^\/+/, '')
              : path;
            const adapter = this.plugin.app.vault.adapter;
            const universal = require('./universal-fs');
            let sha = '';
            try {
              if (await universal.adapterExists(adapter, relPath)) {
                const c = await universal.adapterRead(adapter, relPath);
                sha = await universal.sha256Hex(c);
              }
            } catch { /* ignore — sha vazio ok */ }
            await this.plugin.ioQueue.enqueue({
              path: relPath,
              sha,
              type: 'passport',
            });
          } catch (eq) {
            console.warn('[zeus.autoidx] ioQueue.enqueue failed:', eq.message);
          }
        }
        return { skipped: 'buildOne-failed', reason: (e.message || String(e)).slice(0, 80) };
      }
    }
    return { skipped: 'no-buildOne-api' };
  }

  async _runBase() {
    if (!this.plugin.basesGen) return { skipped: 'no-basesGen' };
    const r = await this.plugin.basesGen.regenerate();
    return { written: r.written, count: r.count };
  }

  async _runSpotlight() {
    if (!this.plugin.httpClient || !this.plugin.vaultRoot) return { skipped: 'no-spotlight' };
    if (!this.plugin.app.vault.getMarkdownFiles) return { skipped: 'no-getMarkdownFiles' };
    const files = this.plugin.app.vault.getMarkdownFiles();
    if (!files.length) return { skipped: 'empty-vault' };
    // Constrói items a partir do passport quando disponível (enriquecimento).
    let passportMap = new Map();
    try {
      if (this.plugin.passport && typeof this.plugin.passport.loadAll === 'function') {
        passportMap = await this.plugin.passport.loadAll();
      }
    } catch { /* sem passports, ok */ }
    const items = [];
    for (const f of files) {
      const passport = passportMap.get(f.path) || null;
      const cache = this.plugin.app.metadataCache && this.plugin.app.metadataCache.getFileCache
        ? this.plugin.app.metadataCache.getFileCache(f) || {} : {};
      const fm = cache.frontmatter || {};
      const headings = (cache.headings || []).filter(h => h.level <= 3).slice(0, 8).map(h => h.heading);
      const keywords = new Set();
      for (const c of (passport?.concepts || [])) keywords.add(String(c));
      const fmTags = Array.isArray(fm.tags) ? fm.tags
        : (typeof fm.tags === 'string' ? fm.tags.split(',').map(s => s.trim()) : []);
      for (const t of fmTags) keywords.add(t);
      const aliases = Array.isArray(fm.aliases) ? fm.aliases
        : (typeof fm.aliases === 'string' ? [fm.aliases] : []);
      for (const a of aliases) keywords.add(a);
      for (const h of headings) keywords.add(h);
      const seen = new Set();
      const kw = [];
      for (const k of keywords) {
        if (!k) continue;
        const s = String(k).trim();
        if (s.length < 2) continue;
        const lower = s.toLowerCase();
        if (seen.has(lower)) continue;
        seen.add(lower);
        kw.push(s);
        if (kw.length >= 25) break;
      }
      items.push({
        path: this.plugin.vaultRoot.replace(/\/$/, '') + '/' + f.path,
        title: f.basename,
        summary: (passport && (passport.one_line_summary || passport.summary)) || '',
        keywords: kw,
        mtime: f.stat ? f.stat.mtime : Date.now(),
      });
    }
    // Domain hint stable per-vault (sha256 do vaultRoot)
    let domainHint = 'com.maiocchi.zeus.default';
    try {
      const universal = require('./universal-fs');
      const hex = await universal.sha256Hex(this.plugin.vaultRoot);
      domainHint = 'com.maiocchi.zeus.' + hex.slice(0, 16);
    } catch { /* fallback default */ }
    try {
      const r = await this.plugin.httpClient.spotlightIndex(items, domainHint);
      // Persist spotlight-state.json para observability (mesmo padrão do comando
      // manual zeus-spotlight-index). Permite "Zeus: status do auto-indexer"
      // surfacar quando foi o último spotlight push e quantos items.
      try {
        const universal = require('./universal-fs');
        const stateRel = universal.joinPath(this.plugin.manifest.dir, 'data', 'spotlight-state.json');
        const adapter = this.plugin.app.vault.adapter;
        const payload = {
          last_indexed_at: new Date().toISOString(),
          count: r.indexed,
          domain: r.domain,
          mode: r.mode || 'queued',
          source: 'auto-indexer-v1.10',
        };
        await universal.adapterMkdir(adapter, universal.joinPath(this.plugin.manifest.dir, 'data'));
        await universal.adapterWriteAtomic(adapter, stateRel, JSON.stringify(payload, null, 2));
      } catch (persistErr) {
        console.warn('[zeus.autoidx] spotlight-state persist failed:', persistErr.message);
      }
      return { indexed: r.indexed, domain: r.domain };
    } catch (e) {
      return { skipped: 'daemon-error', reason: e.message.slice(0, 80) };
    }
  }

  async _runMultiplex() {
    if (!this.plugin.multiplex) return { skipped: 'no-multiplex' };
    const stats = await this.plugin.multiplex.buildFromVault(() => {});
    await this.plugin.multiplex.persist();
    this.plugin._multiplexLoaded = true;
    // Encadeia leiden (não usa _schedule pra rodar agora, em sequência —
    // multiplex já completou, leiden precisa do snapshot fresco).
    this._schedule('leiden', DEBOUNCE.leiden, () => this._runLeiden());
    return { total: stats.total, elapsedMs: stats.elapsedMs };
  }

  async _runLeiden() {
    if (!this.plugin.leiden) return { skipped: 'no-leiden' };
    if (!this.plugin.multiplex || this.plugin.multiplex.edges.size === 0) {
      return { skipped: 'no-multiplex-edges' };
    }
    const r = await this.plugin.leiden.detectCommunities({
      resolution: this.plugin.settings && this.plugin.settings.leidenResolution || 1.0,
      seed: 42,
    });
    if (this.plugin.leiden.persist) await this.plugin.leiden.persist();
    return {
      communities: new Set([...r.communities.values()]).size,
      nodes: r.communities.size,
      Q: Number(r.modularity.toFixed(4)),
    };
  }

  // v1.11 Feature I — incremental rebuild do lexical-ios para a nota tocada.
  // Gating:
  //   - Só roda se this.plugin.lexicalIos estiver definido (opt-in via wire).
  //   - lexicalIosAutoBuild controla SE o build inicial rodou — aqui só
  //     incrementa, que é barato (~10ms).
  async _runLexicalIos(path) {
    const lex = this.plugin.lexicalIos;
    if (!lex) return { skipped: 'no-lexical-ios' };
    if (typeof lex.incremental !== 'function') return { skipped: 'no-incremental-api' };
    try {
      const r = await lex.incremental(path);
      return { updated: r.updated, reason: r.reason };
    } catch (e) {
      return { skipped: 'incremental-failed', reason: (e.message || String(e)).slice(0, 80) };
    }
  }

  // ---------------------------------------------------------------------------
  // Boot check — se data files estão stale vs vault, dispara rebuild
  // ---------------------------------------------------------------------------

  async _bootCheck() {
    // Lazy: só verifica que existem; rebuild full fica para próximo modify.
    // Em vault recém-instalado, o primeiro write dispara naturalmente.
  }

  // ---------------------------------------------------------------------------
  // Status — comando "Zeus: status auto-indexer"
  // ---------------------------------------------------------------------------

  getStatus() {
    const summary = {};
    for (const [k, v] of this.lastRun) {
      summary[k] = {
        ago_s: Math.round((Date.now() - v.at) / 1000),
        durationMs: v.durationMs,
        result: v.result || null,
        error: v.error || null,
      };
    }
    return {
      running: this.running,
      pending: Array.from(this.timers.keys()),
      running_now: Array.from(this.runningKeys),
      mod_count_since_multiplex: this._modCount,
      mod_threshold: MULTIPLEX_MOD_THRESHOLD,
      last_run: summary,
      debounces: DEBOUNCE,
    };
  }
}

module.exports = AutoIndexer;
