// python-worker.js — v1.3 Python worker layer
//
// Spawns Python scripts in bin/ as one-shot processes. Decouples batch jobs
// (apple-fm-sdk, MLX inference, regression eval) from the daemon SwiftNIO loop.
//
// Contract:
//   - script receives JSON via stdin (single line)
//   - script returns JSON via stdout (single line)
//   - exit code 0 = ok, non-zero = error
//
// Discovery: prefers <plugin-dir>/bin/<scriptName>.py, falls back to PATH.
//
// Example:
//   const { runPythonWorker } = require('./lib/python-worker');
//   const out = await runPythonWorker('batch_eval', { action: 'version' });
//   console.log(out.result.apple_fm_sdk_version);

'use strict';

// v1.4.2-ios: Node builtins (path/fs/child_process) não existem no Obsidian
// mobile (Capacitor sandbox). require() não-guardado no topo do módulo lança e
// impede o carregamento do plugin inteiro — main.js faz pluginRequire deste
// módulo no topo (eager). Guardamos; as funções abaixo degradam com elegância.
let path = null;
let fs = null;
let spawn = null;
try { path = require('path'); } catch (_) { /* iOS sandbox */ }
try { fs = require('fs'); } catch (_) { /* iOS sandbox */ }
try { ({ spawn } = require('child_process')); } catch (_) { /* iOS sandbox */ }

/**
 * Resolve a Python script path within the plugin's bin/ directory.
 * @param {string} pluginDir - absolute path to the plugin directory
 * @param {string} scriptName - script name without extension (e.g. "batch_eval")
 * @returns {string|null} absolute path or null if not found
 */
function resolveScript(pluginDir, scriptName) {
    if (!path || !fs) return null;  // v1.4.2-ios: sem Node builtins (mobile)
    const candidates = [
        path.join(pluginDir, 'bin', `${scriptName}.py`),
        path.join(pluginDir, 'bin', scriptName),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    return null;
}

/**
 * Spawn a Python worker script with a JSON payload on stdin.
 * Resolves with parsed JSON output. Rejects on timeout / non-zero exit / parse error.
 *
 * @param {string} pluginDir - absolute plugin path (e.g. this.manifest.dir)
 * @param {string} scriptName - script in bin/ (e.g. "batch_eval")
 * @param {object} payload - JSON-serializable payload sent to stdin
 * @param {object} [opts]
 * @param {string} [opts.python='python3'] - python executable
 * @param {number} [opts.timeoutMs=30000] - kill after N ms
 * @returns {Promise<object>} parsed JSON from stdout
 */
function runPythonWorker(pluginDir, scriptName, payload, opts = {}) {
    return new Promise((resolve, reject) => {
        if (!spawn) {
            return reject(new Error(
                'python worker indisponível neste dispositivo: child_process ausente (Obsidian mobile/iOS)'));
        }
        const scriptPath = resolveScript(pluginDir, scriptName);
        if (!scriptPath) {
            return reject(new Error(`python worker not found: bin/${scriptName}.py`));
        }
        const python = opts.python || 'python3';
        const timeoutMs = opts.timeoutMs || 30000;

        const child = spawn(python, [scriptPath], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, PYTHONUNBUFFERED: '1' },
        });

        let stdout = '';
        let stderr = '';
        let settled = false;

        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { child.kill('SIGKILL'); } catch (_) {}
            reject(new Error(`python worker timeout after ${timeoutMs}ms: ${scriptName}`));
        }, timeoutMs);

        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });

        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(new Error(`python worker spawn failed: ${err.message}`));
        });

        child.on('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code !== 0) {
                return reject(new Error(`python worker exit ${code}: ${stderr.trim() || stdout.trim()}`));
            }
            try {
                const parsed = JSON.parse(stdout.trim());
                resolve(parsed);
            } catch (e) {
                reject(new Error(`python worker invalid json: ${e.message}; stdout=${stdout.slice(0, 500)}`));
            }
        });

        try {
            child.stdin.write(JSON.stringify(payload || {}));
            child.stdin.end();
        } catch (e) {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { child.kill('SIGKILL'); } catch (_) {}
            reject(new Error(`python worker stdin write failed: ${e.message}`));
        }
    });
}

module.exports = { runPythonWorker, resolveScript };
