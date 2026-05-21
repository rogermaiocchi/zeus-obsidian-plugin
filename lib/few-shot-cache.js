'use strict';

/*
 * few-shot-cache.js — cache vault-local de exemplos few-shot por tarefa.
 *
 * Implementa o mecanismo de aprendizado contínuo on-device do Qwen 2.5 3B:
 * conforme o sistema executa suas atividades generativas nativas (summarize,
 * refine, enrich, prompt, hyde, agent_query, graph_extract), os pares
 * (input, output) de alta qualidade são capturados e reutilizados nas
 * próximas inferências como exemplos contextuais.
 *
 * Arquitetura:
 *   1. Cada chamada generativa bem-sucedida → `cache.add(task, input, output)`
 *   2. Próxima chamada da mesma tarefa → `cache.topK(task, 3)` prepend ao prompt
 *   3. Daemon recebe `few_shot_examples: [{input, output}]` no body HTTP
 *   4. QwenRunner usa esses exemplos + bundle examples (vault-local tem prioridade)
 *
 * Persistência: `data/zeus-fewshot-cache.jsonl` (vault-local, iCloud-safe, append)
 * Ring buffer: máx 50 exemplos por tarefa, curados por qualidade + recência
 * Dedup: baseado em hash dos primeiros 120 chars do input
 *
 * Sinais de qualidade:
 *   1.0 — output aceito sem edição (confirmação implícita)
 *   0.8 — output aceito com edição menor (<20% chars alterados)
 *   0.5 — output aceito com edição maior
 *   0.0 — output descartado/rejeitado → não entra no cache
 *
 * v1.15.1 — Zeus Obsidian Plugin aprendizado contínuo on-device.
 */

const CACHE_FILE = 'data/zeus-fewshot-cache.jsonl';
const MAX_PER_TASK = 50;
const MIN_QUALITY = 0.4;
const TASKS = [
  'summarize', 'refine', 'enrich', 'prompt',
  'hyde', 'agent_query', 'graph_extract',
];

class FewShotCache {
  /**
   * @param {object} adapter — Obsidian vault.adapter (read/write/exists)
   */
  constructor(adapter) {
    this._adapter = adapter;
    this._cache = {}; // task → [{task,input,output,quality,ts,key}]
    this._loaded = false;
    this._dirty = false;
  }

  // ---------------------------------------------------------------------------
  // API pública
  // ---------------------------------------------------------------------------

  /**
   * Registra um novo par (input, output) para uma tarefa.
   * Só entra no cache se quality >= MIN_QUALITY.
   *
   * @param {string} task — nome da tarefa (um dos 7 comandos)
   * @param {string|object} input — input da tarefa (string ou JSON-serializable)
   * @param {string|object} output — output da tarefa
   * @param {number} quality — 0.0..1.0 (default 1.0 = aceito sem edição)
   */
  async add(task, input, output, quality = 1.0) {
    if (!TASKS.includes(task)) return;
    if (quality < MIN_QUALITY) return;
    await this._ensureLoaded();

    const inputStr = typeof input === 'string' ? input : JSON.stringify(input);
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output);
    if (!inputStr || !outputStr) return;

    const key = _hashKey(inputStr);
    if (!this._cache[task]) this._cache[task] = [];

    // Dedup: atualiza qualidade se key já existir
    const existingIdx = this._cache[task].findIndex(e => e.key === key);
    if (existingIdx >= 0) {
      const existing = this._cache[task][existingIdx];
      if (quality >= existing.quality) {
        this._cache[task][existingIdx] = { task, input: inputStr, output: outputStr, quality, ts: Date.now(), key };
        this._dirty = true;
      }
      await this._maybePersist();
      return;
    }

    this._cache[task].push({ task, input: inputStr, output: outputStr, quality, ts: Date.now(), key });
    this._dirty = true;

    // Ring buffer: mantém top MAX_PER_TASK por (quality desc, ts desc)
    if (this._cache[task].length > MAX_PER_TASK) {
      this._cache[task].sort((a, b) =>
        b.quality - a.quality || b.ts - a.ts
      );
      this._cache[task] = this._cache[task].slice(0, MAX_PER_TASK);
    }

    await this._maybePersist();
  }

  /**
   * Retorna até k exemplos de alta qualidade para uma tarefa.
   * Usados pelo caller para passar como `few_shot_examples` ao daemon.
   *
   * @param {string} task
   * @param {number} k — máximo de exemplos (default 3)
   * @returns {Array<{input:string, output:string}>}
   */
  async topK(task, k = 3) {
    await this._ensureLoaded();
    const entries = this._cache[task] || [];
    return entries
      .filter(e => e.quality >= 0.7)
      .sort((a, b) => b.quality - a.quality || b.ts - a.ts)
      .slice(0, k)
      .map(e => ({ input: e.input, output: e.output }));
  }

  /**
   * Estatísticas do cache para diagnóstico (/zeus doctor).
   * @returns {{total: number, byTask: Object}}
   */
  async stats() {
    await this._ensureLoaded();
    const byTask = {};
    let total = 0;
    for (const task of TASKS) {
      const n = (this._cache[task] || []).length;
      byTask[task] = n;
      total += n;
    }
    return { total, byTask };
  }

  /**
   * Força flush para disco (útil ao fechar o plugin).
   */
  async flush() {
    this._dirty = true;
    await this._persist();
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  async _ensureLoaded() {
    if (this._loaded) return;
    this._loaded = true;
    try {
      const exists = typeof this._adapter.exists === 'function'
        ? await this._adapter.exists(CACHE_FILE)
        : false;
      if (!exists) return;
      const text = await this._adapter.read(CACHE_FILE);
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const e = JSON.parse(t);
          if (!e.task || !e.input || !e.output || !TASKS.includes(e.task)) continue;
          if (!this._cache[e.task]) this._cache[e.task] = [];
          // Adiciona apenas se não duplicado
          const key = e.key || _hashKey(e.input);
          if (!this._cache[e.task].some(x => x.key === key)) {
            this._cache[e.task].push({ ...e, key });
          }
        } catch { /* skip malformed line */ }
      }
    } catch { /* file missing or unreadable — start fresh */ }
  }

  async _maybePersist() {
    if (!this._dirty) return;
    // Throttle: no máximo uma escrita a cada 2s (evita I/O excessivo em batch)
    const now = Date.now();
    if (this._lastPersist && now - this._lastPersist < 2000) return;
    await this._persist();
  }

  async _persist() {
    if (!this._dirty) return;
    this._dirty = false;
    this._lastPersist = Date.now();
    try {
      const lines = [];
      for (const task of TASKS) {
        for (const e of (this._cache[task] || [])) {
          const { key, ...clean } = e;
          lines.push(JSON.stringify(clean));
        }
      }
      await this._adapter.write(CACHE_FILE, lines.join('\n') + (lines.length ? '\n' : ''));
    } catch (err) {
      console.warn('[zeus.fewshot-cache] persist failed:', err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Hash determinístico simples para dedup de inputs (FNV-1a 32-bit)
// ---------------------------------------------------------------------------
function _hashKey(str) {
  const s = str.slice(0, 120); // primeiros 120 chars
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (Math.imul(h, 0x01000193)) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

module.exports = FewShotCache;
