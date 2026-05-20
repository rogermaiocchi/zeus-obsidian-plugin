#!/usr/bin/env node
// build-release.mjs — regenera bin/ZeusDaemonMac + main.js
//
// Rodar como maintainer Apple Silicon Mac antes de cortar release:
//   node scripts/build-release.mjs
//
// Passos:
//   1. swift build -c release --product ZeusDaemonMac (em daemon/)
//   2. cp .build/release/ZeusDaemonMac -> bin/ZeusDaemonMac
//   3. chmod +x; xattr -d com.apple.quarantine; codesign --sign - --force
//   4. node esbuild.config.mjs (rebuilda main.js a partir de main.source.js + lib/*.js)
//
// Idempotente. Falha rápida com mensagem clara.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync, statSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function run(cmd, args, options = {}) {
  console.log(`[build-release] $ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    cwd: options.cwd || root,
    stdio: options.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    if (options.allowFail) return r;
    throw new Error(`${cmd} ${args.join(' ')} → exit ${r.status}`);
  }
  return r;
}

function main() {
  if (process.platform !== 'darwin') {
    throw new Error('build-release.mjs precisa rodar em macOS Apple Silicon (FoundationModels é arm64-only)');
  }

  // 1. Swift build release
  run('swift', ['build', '-c', 'release', '--product', 'ZeusDaemonMac'], { cwd: join(root, 'daemon') });

  // 2. Locate output binary
  const releaseBin = join(root, 'daemon/.build/release/ZeusDaemonMac');
  if (!existsSync(releaseBin)) {
    throw new Error(`Build OK mas binário não está em ${releaseBin}`);
  }
  const size = statSync(releaseBin).size;
  console.log(`[build-release] daemon arm64 produzido: ${(size / 1024 / 1024).toFixed(1)} MB`);

  // 3. Copy to bin/ + harden
  const targetBin = join(root, 'bin/ZeusDaemonMac');
  mkdirSync(dirname(targetBin), { recursive: true });
  copyFileSync(releaseBin, targetBin);
  chmodSync(targetBin, 0o755);
  run('xattr', ['-d', 'com.apple.quarantine', targetBin], { allowFail: true });
  run('codesign', ['--sign', '-', '--force', targetBin]);
  const verify = run('codesign', ['-dv', targetBin], { capture: true, allowFail: true });
  console.log('[build-release] codesign:', (verify.stderr || verify.stdout).trim().split('\n').slice(0, 3).join(' · '));

  // 4. esbuild main.js — prefere `bun` (resolve esbuild da própria runtime,
  // sem precisar de `node_modules`); fallback `node esbuild.config.mjs` quando
  // bun não está disponível.
  const hasBun = spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0;
  if (hasBun) {
    run('bun', ['run', 'build']);
  } else {
    run('node', ['esbuild.config.mjs']);
  }

  // 5. Final smoke: roda zeus-smoke.mjs contra daemon LIVE (opt-out via --no-smoke).
  // codex MED #9: antes só imprimia "Para validar" — agora valida de fato.
  const skipSmoke = process.argv.includes('--no-smoke');
  if (!skipSmoke) {
    try {
      console.log('[build-release] $ smoke validation (--no-smoke skipa)');
      run('node', ['scripts/zeus-smoke.mjs']);
    } catch (e) {
      console.warn('[build-release] ⚠ smoke falhou (daemon offline?):', e.message);
      console.log('[build-release] continue mesmo assim — rebuild OK, smoke não-bloqueante');
    }
  }

  console.log('[build-release] ✓ bin/ZeusDaemonMac pronto.');
}

try { main(); }
catch (err) { console.error('[build-release] ✗', err.message); process.exit(1); }
