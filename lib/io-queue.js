/*
 * io-queue.js — fila iCloud-mediada para Mac consumir tarefas geradas em iOS.
 *
 * v1.11.0 — Feature H (closes "Mac consumes iOS deferred work" gap):
 * quando o iOS gera uma intent de indexação (passport/embed/spotlight) mas
 * NÃO tem daemon FM nativo, enfileira a tarefa em `data/ios-queue/<sha>.json`.
 * O Mac (que tem daemon FM) consome periodicamente (15min via PassportScheduler
 * OU manual via comando) e processa.
 *
 * Codex critique: NÃO usar arquivo único com read-modify-write para a fila —
 * adapterWriteAtomic via rename NÃO é lock forte cross-device em iCloud.
 * Em vez disso: 1 task = 1 arquivo (`data/ios-queue/<sha-of-task>.json`).
 * Idempotência via SHA do task payload (mesmo task → mesmo arquivo → único).
 *
 * Concurrency Mac-side: usa DistributedCoordinator para claim/release por
 * `path` (o lock canônico já existente). Após processar com sucesso, deleta o
 * task file. Em falha, mantém o file — próximo sweep retenta.
 *
 * Schema do task:
 *   {
 *     path: string (vault-relative),
 *     sha: string (sha do conteúdo da nota no momento do enqueue),
 *     type: 'passport' | 'embed' | 'spotlight',
 *     payload: object (opcional, type-específico),
 *     enqueued_at: ISO timestamp,
 *     enqueued_by: deviceId,
 *   }
 *
 * Identidade do task file:
 *   sha-of-task = sha256(JSON.stringify({path, sha, type}))
 *   → idempotente: re-enqueue do mesmo (path, sha, type) é no-op (overwrite
 *     do mesmo conteúdo).
 *
 * Garantia eventual consistency:
 *   - iCloud sync de `data/ios-queue/*.json` leva 5-30s.
 *   - Mac consume() roda 15min ou on-demand → eventual.
 *   - Para sigiloso/confidencial: tasks que tocam notas Clientes/** NÃO devem
 *     ser enfileiradas (Privacy Gate). Caller é responsável.
 */

'use strict';

const universal = require('./universal-fs');

const QUEUE_DIR_NAME = 'ios-queue';
const VALID_TYPES = new Set(['passport', 'embed', 'spotlight']);

class IoQueue {
  /**
   * @param {*} plugin Zeus plugin instance
   */
  constructor(plugin) {
    this.plugin = plugin;
  }

  /**
   * codex HIGH #4 — privacy gate hard-enforced.
   * Recusa paths sigilosos (Clientes/**, ou marcados como privacy:'sigiloso' no
   * payload). Conforme ~/Code/claude-config/rules/juridico.md: Clientes/** é
   * SIGILOSO por default, NÃO pode ir para nenhum caminho cloud — incluindo
   * io-queue que persiste em iCloud sync.
   * @param {string} path — vault-relative
   * @param {object} [payload]
   * @returns {boolean} true se path é privado e NÃO pode ser enfileirado
   */
  static isPrivatePath(path, payload) {
    if (!path) return false;
    // Hard rule: Clientes/** sempre sigiloso
    if (/^Clientes\//i.test(path)) return true;
    // Payload explicit override (caller pode marcar como sigiloso)
    if (payload && payload.privacy && /sigiloso/i.test(String(payload.privacy))) return true;
    // Custom patterns futuros podem ser adicionados aqui
    return false;
  }

  get _adapter() {
    return this.plugin.app.vault.adapter;
  }

  get queueDir() {
    return universal.joinPath(this.plugin.manifest.dir, 'data', QUEUE_DIR_NAME);
  }

  async _ensureDir() {
    await universal.adapterMkdir(this._adapter, universal.joinPath(this.plugin.manifest.dir, 'data'));
    await universal.adapterMkdir(this._adapter, this.queueDir);
  }

  /**
   * SHA do payload identitário do task — garante idempotência.
   * Stringify usa keys ordenadas para evitar variação por ordem de inserção.
   * @param {{path:string, sha:string, type:string}} task
   * @returns {Promise<string>} hex short (16 chars) — colisão prática ~zero
   */
  async _taskSha(task) {
    const canonical = JSON.stringify({
      path: task.path || '',
      sha: task.sha || '',
      type: task.type || '',
    });
    const hex = await universal.sha256Hex(canonical);
    return hex.slice(0, 16);
  }

  async _taskFilePath(task) {
    const sha = await this._taskSha(task);
    return universal.joinPath(this.queueDir, sha + '.json');
  }

  /**
   * Enfileira um task. Idempotente: mesmo (path, sha, type) → mesmo file.
   *
   * @param {{path:string, sha:string, type:string, payload?:object}} task
   * @returns {Promise<{enqueued: boolean, taskSha: string, file: string, reason?: string}>}
   */
  async enqueue(task) {
    if (!task || typeof task !== 'object') {
      return { enqueued: false, reason: 'task inválido' };
    }
    if (!task.path || typeof task.path !== 'string') {
      return { enqueued: false, reason: 'path ausente' };
    }
    if (!task.type || !VALID_TYPES.has(task.type)) {
      return { enqueued: false, reason: `type inválido (esperado: ${[...VALID_TYPES].join('|')})` };
    }
    // codex HIGH #4: privacy gate hard-enforced (era só comentário no header).
    // Paths em Clientes/** (sigiloso default per claude-config/juridico.md) ou
    // marcados como `payload.privacy === 'sigiloso'` NÃO podem ir pra fila —
    // io-queue persiste em iCloud sync (data/ios-queue/*.json), o que viola o
    // privacy gate sigiloso (não-cloud) do plugin Zeus.
    if (IoQueue.isPrivatePath(task.path, task.payload)) {
      return { enqueued: false, reason: 'privacy-gate: path sigiloso, não enfileirado' };
    }
    if (!task.sha) {
      // Sha do conteúdo é central pra idempotência; aceita sem (caller pode não
      // tê-lo), mas marca explicitamente.
      task.sha = '';
    }
    await this._ensureDir();
    const taskSha = await this._taskSha(task);
    const file = universal.joinPath(this.queueDir, taskSha + '.json');

    const deviceId = (this.plugin.coordinator && this.plugin.coordinator.deviceId) || 'unknown';
    const fullTask = {
      path: task.path,
      sha: task.sha,
      type: task.type,
      payload: task.payload || null,
      enqueued_at: task.enqueued_at || new Date().toISOString(),
      enqueued_by: task.enqueued_by || deviceId,
      task_sha: taskSha,
    };
    await universal.adapterWriteAtomic(this._adapter, file, JSON.stringify(fullTask));
    return { enqueued: true, taskSha, file };
  }

  /**
   * Lista todos os tasks pendentes na fila.
   * @returns {Promise<Array<object>>}
   */
  async list() {
    await this._ensureDir();
    const listing = await universal.adapterList(this._adapter, this.queueDir);
    const entries = (listing && listing.files) || [];
    const out = [];
    for (const f of entries) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await universal.adapterRead(this._adapter, f);
        const task = JSON.parse(raw);
        task._file = f;
        out.push(task);
      } catch (e) {
        console.warn('[zeus][io-queue] skip malformed task:', f, e.message);
      }
    }
    return out;
  }

  /**
   * Consome UM task: claim via DistributedCoordinator → processor(task) →
   * delete file em sucesso.
   *
   * Idempotente:
   *   - Se task já foi processada (output existe), apenas deleta o file.
   *     Caller (processor) é responsável por sinalizar isso via `{ alreadyDone: true }`.
   *   - Se claim falha (outro device pegou), pula e retorna `{ consumed: false, reason }`.
   *   - Em erro do processor, file fica na fila para retry.
   *
   * @param {object} task
   * @param {(task) => Promise<{ok: boolean, alreadyDone?: boolean, error?: string}>} processor
   * @returns {Promise<{consumed: boolean, reason?: string, result?: any}>}
   */
  async consume(task, processor) {
    if (!task || !task.path) {
      return { consumed: false, reason: 'task inválido' };
    }
    if (typeof processor !== 'function') {
      return { consumed: false, reason: 'processor não é função' };
    }

    // Claim via coordinator (mesmo lock que PassportScheduler usa) — evita
    // que 2 devices Macs processem o mesmo task em paralelo se a fila for
    // syncada via iCloud para ambos.
    const coord = this.plugin.coordinator;
    let claimed = false;
    if (coord) {
      try {
        const claim = await coord.claim(task.path);
        if (!claim.claimed) {
          return { consumed: false, reason: `claim held by ${claim.current_holder}` };
        }
        claimed = true;
      } catch (e) {
        console.warn('[zeus][io-queue] claim failed:', e.message);
        // Sem claim, ainda processa — pior caso é doppia escrita (idempotente).
      }
    }

    let result;
    try {
      result = await processor(task);
    } catch (e) {
      result = { ok: false, error: e.message || String(e) };
    } finally {
      if (claimed && coord) {
        try { await coord.release(task.path); } catch { /* ignore */ }
      }
    }

    // Em sucesso OU alreadyDone, deleta o file. Em erro, mantém para retry.
    if (result && (result.ok || result.alreadyDone)) {
      const file = task._file || (await this._taskFilePath(task));
      try {
        await universal.adapterRemove(this._adapter, file);
      } catch (e) {
        console.warn('[zeus][io-queue] remove task file failed:', file, e.message);
      }
      return { consumed: true, result };
    }
    return { consumed: false, reason: (result && result.error) || 'processor não-OK', result };
  }

  /**
   * Conta tasks pendentes.
   * @returns {Promise<number>}
   */
  async size() {
    await this._ensureDir();
    const listing = await universal.adapterList(this._adapter, this.queueDir);
    const entries = (listing && listing.files) || [];
    return entries.filter(f => f.endsWith('.json')).length;
  }

  /**
   * Status agregado: total + breakdown por type.
   * @returns {Promise<{total:number, byType:object, oldest:string|null}>}
   */
  async status() {
    const tasks = await this.list();
    const byType = {};
    let oldest = null;
    for (const t of tasks) {
      const ty = t.type || 'unknown';
      byType[ty] = (byType[ty] || 0) + 1;
      if (t.enqueued_at && (!oldest || t.enqueued_at < oldest)) {
        oldest = t.enqueued_at;
      }
    }
    return { total: tasks.length, byType, oldest };
  }
}

module.exports = IoQueue;
