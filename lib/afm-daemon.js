/**
 * afm-daemon.js — Persistent JSON-RPC client for `afm serve` (Apple Foundation Models MCP server)
 *
 * Purpose
 * -------
 * Eliminate the ~30s cold-start latency of `child_process.spawn(afm, [...])` for every
 * single FoundationModels call. Instead, spawn `afm serve` ONCE per Obsidian session
 * and dispatch all subsequent operations as JSON-RPC requests over its stdio pipes.
 *
 * Protocol
 * --------
 * Anthropic Model Context Protocol (MCP), JSON-RPC 2.0, line-delimited (one JSON object
 * per stdout line, terminated by `\n`).
 *
 *   request:  {"jsonrpc":"2.0","id":<int>,"method":"tools/call",
 *              "params":{"name":"metafm_summarize","arguments":{...}}}
 *   response: {"jsonrpc":"2.0","id":<int>,"result":{...}}
 *             or {"jsonrpc":"2.0","id":<int>,"error":{"code":<int>,"message":"..."}}
 *
 * On startup we also call `tools/list` to discover available tool names and log them
 * via console.info — useful for verifying whether e.g. `metafm_embed` is exposed
 * (if not, callers must fall back to direct spawn for that op).
 *
 * Tools typically exposed:
 *   metafm_summarize, metafm_rewrite, metafm_classify, metafm_tags, metafm_prompt,
 *   metafm_translate, metafm_ocr, metafm_graph_extract, metafm_enrich, metafm_agent,
 *   metafm_doctor
 *
 * Lifecycle
 * ---------
 *   const d = new AfmDaemon('/abs/path/to/afm');
 *   await d.start();                                 // spawn + handshake
 *   const r = await d.call('metafm_summarize', {...}); // JSON-RPC tools/call
 *   await d.stop();                                  // SIGTERM, escalate to SIGKILL
 *
 * No external dependencies — only Node built-ins (`child_process`, `path`, `fs`).
 */

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');

const DEFAULT_TIMEOUT_MS = 30000;
const STARTUP_TIMEOUT_MS = 15000;   // time we wait for tools/list to resolve
const STOP_GRACE_MS = 2000;         // SIGTERM → SIGKILL escalation

class AfmDaemon {
  constructor(afmBinPath) {
    if (!afmBinPath || typeof afmBinPath !== 'string') {
      throw new Error('AfmDaemon: afmBinPath (string) required');
    }
    this.binPath = afmBinPath;
    this.proc = null;
    this.alive = false;
    this.starting = null;          // Promise — resolves when handshake done
    this.nextId = 1;
    this.pending = new Map();      // id → { resolve, reject, timer }
    this.queue = [];               // calls received before start() resolved
    this.stdoutBuf = '';
    this.tools = [];               // populated by tools/list on startup
  }

  isAlive() {
    return this.alive && this.proc !== null;
  }

  // Generate next request id (monotonic, JSON-safe int).
  _nextId() {
    const id = this.nextId++;
    if (this.nextId > 0x7fffffff) this.nextId = 1;
    return id;
  }

  // Internal: write a JSON-RPC frame to stdin (line-delimited).
  _send(obj) {
    if (!this.proc || !this.proc.stdin.writable) {
      throw new Error('afm-daemon: stdin not writable');
    }
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  // Internal: parse newline-delimited JSON from stdout buffer; dispatch to pending.
  _onStdout(chunk) {
    this.stdoutBuf += chunk.toString('utf8');
    let nl;
    while ((nl = this.stdoutBuf.indexOf('\n')) >= 0) {
      const line = this.stdoutBuf.slice(0, nl).trim();
      this.stdoutBuf = this.stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        console.warn('[afm-daemon] non-JSON stdout line:', line.slice(0, 200));
        continue;
      }
      this._dispatch(msg);
    }
  }

  _dispatch(msg) {
    // Ignore server-initiated notifications (no id) — log only.
    if (msg.id === undefined || msg.id === null) {
      // Notifications (e.g. progress events) — skip silently for now.
      return;
    }
    const pend = this.pending.get(msg.id);
    if (!pend) {
      console.warn('[afm-daemon] response with unknown id:', msg.id);
      return;
    }
    this.pending.delete(msg.id);
    clearTimeout(pend.timer);
    if (msg.error) {
      const err = new Error(`afm-daemon JSON-RPC error ${msg.error.code}: ${msg.error.message}`);
      err.code = msg.error.code;
      err.data = msg.error.data;
      pend.reject(err);
    } else {
      pend.resolve(msg.result);
    }
  }

  // Reject every in-flight + queued call with `err`. Used on crash and stop().
  _failAll(err) {
    for (const [id, pend] of this.pending) {
      clearTimeout(pend.timer);
      pend.reject(err);
    }
    this.pending.clear();
    for (const q of this.queue) q.reject(err);
    this.queue = [];
  }

  // Spawn `afm serve`, attach listeners, wait for handshake (tools/list).
  // Idempotent — safe to await multiple times.
  async start() {
    if (this.alive) return;
    if (this.starting) return this.starting;

    if (!fs.existsSync(this.binPath)) {
      throw new Error(`afm-daemon: binary not found at ${this.binPath}`);
    }

    this.starting = new Promise((resolve, reject) => {
      let earlyExitStderr = '';
      let resolvedStart = false;

      let proc;
      try {
        proc = spawn(this.binPath, ['serve'], { stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) {
        reject(new Error(`afm-daemon: spawn failed: ${e.message}`));
        return;
      }

      this.proc = proc;

      proc.stdout.on('data', (d) => this._onStdout(d));

      proc.stderr.on('data', (d) => {
        const s = d.toString('utf8');
        if (!resolvedStart) earlyExitStderr += s;
        // Always pipe to console.warn — debug visibility.
        for (const line of s.split('\n')) {
          if (line.trim()) console.warn('[afm-daemon]', line);
        }
      });

      proc.on('error', (e) => {
        this.alive = false;
        if (!resolvedStart) {
          resolvedStart = true;
          reject(new Error(`afm-daemon: process error: ${e.message}`));
        }
        this._failAll(new Error(`afm-daemon: process error: ${e.message}`));
      });

      proc.on('exit', (code, signal) => {
        this.alive = false;
        this.proc = null;
        const reason = signal ? `signal=${signal}` : `code=${code}`;
        if (!resolvedStart) {
          resolvedStart = true;
          reject(new Error(
            `afm-daemon: 'afm serve' exited before ready (${reason}). stderr: ${earlyExitStderr.slice(0, 400)}`
          ));
          return;
        }
        this._failAll(new Error(`afm-daemon: process exited (${reason})`));
      });

      // Mark alive optimistically so _send/call work during handshake.
      this.alive = true;

      // Handshake: tools/list to discover capabilities.
      const startupTimer = setTimeout(() => {
        if (resolvedStart) return;
        resolvedStart = true;
        try { proc.kill('SIGTERM'); } catch (_) {}
        reject(new Error(`afm-daemon: handshake timeout after ${STARTUP_TIMEOUT_MS}ms. stderr: ${earlyExitStderr.slice(0, 400)}`));
      }, STARTUP_TIMEOUT_MS);

      this._rawCall('tools/list', {}, STARTUP_TIMEOUT_MS)
        .then((result) => {
          clearTimeout(startupTimer);
          if (resolvedStart) return;
          resolvedStart = true;
          // Result shape per MCP: { tools: [{name, description, inputSchema}, ...] }
          const toolList = (result && Array.isArray(result.tools)) ? result.tools : [];
          this.tools = toolList.map(t => t && t.name).filter(Boolean);
          console.info('[afm-daemon] ready —', this.tools.length, 'tools:', this.tools.join(', '));
          if (!this.tools.includes('metafm_embed')) {
            console.info('[afm-daemon] note: metafm_embed not exposed by serve; callers must fall back to direct spawn for embeddings.');
          }
          // Flush queued calls.
          const q = this.queue;
          this.queue = [];
          for (const item of q) {
            this._performCall(item.tool, item.params, item.timeout)
              .then(item.resolve, item.reject);
          }
          resolve();
        })
        .catch((e) => {
          clearTimeout(startupTimer);
          if (resolvedStart) return;
          resolvedStart = true;
          try { proc.kill('SIGTERM'); } catch (_) {}
          reject(new Error(`afm-daemon: tools/list failed: ${e.message}`));
        });
    });

    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  // Send a JSON-RPC request and return a Promise for its result.
  // `method` is the raw JSON-RPC method (e.g. 'tools/list' or 'tools/call').
  _rawCall(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.alive || !this.proc) {
        reject(new Error('afm-daemon: not alive'));
        return;
      }
      const id = this._nextId();
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`afm-daemon: timeout after ${timeoutMs}ms (method=${method}, id=${id})`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._send({ jsonrpc: '2.0', id, method, params });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  // Internal: actually emit a tools/call once daemon is ready.
  _performCall(toolName, params, timeoutMs) {
    return this._rawCall('tools/call', { name: toolName, arguments: params || {} }, timeoutMs);
  }

  // Public: invoke an MCP tool by name. Auto-starts (and auto-restarts on crash).
  async call(toolName, params, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (!toolName || typeof toolName !== 'string') {
      throw new Error('afm-daemon: toolName required');
    }

    // Auto-restart if process crashed since last call.
    if (!this.alive) {
      await this.start();
    }

    // If start() is still in flight, queue the call until handshake completes.
    if (this.starting) {
      return new Promise((resolve, reject) => {
        this.queue.push({ tool: toolName, params, timeout: timeoutMs, resolve, reject });
      });
    }

    return this._performCall(toolName, params, timeoutMs);
  }

  // Graceful shutdown: SIGTERM, wait STOP_GRACE_MS, escalate to SIGKILL.
  async stop() {
    if (!this.proc) {
      this.alive = false;
      return;
    }
    const proc = this.proc;
    this.alive = false;

    // Fail any in-flight calls so callers don't hang.
    this._failAll(new Error('afm-daemon: shutting down'));

    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this.proc = null;
        resolve();
      };
      proc.once('exit', finish);
      try { proc.kill('SIGTERM'); } catch (_) {}
      setTimeout(() => {
        if (done) return;
        try { proc.kill('SIGKILL'); } catch (_) {}
        // Give the OS a tick to deliver SIGKILL.
        setTimeout(finish, 200);
      }, STOP_GRACE_MS);
    });
  }
}

module.exports = AfmDaemon;
