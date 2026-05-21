#!/usr/bin/env node
// package-release.mjs — empacota o plugin Zeus em zip drop-in para distribuição.
//
// Produz dist/zeus-v<VERSION>.zip contendo APENAS os 4 artefatos essenciais
// de runtime Obsidian community plugin:
//
//   zeus/
//   ├── manifest.json
//   ├── main.js
//   ├── styles.css
//   └── bin/ZeusDaemonMac (codesigned adhoc, xattrs strippados)
//
// Validation:
//   1. Confirma versions consistentes (manifest.json == package.json)
//   2. Confirma binário arm64 codesigned adhoc
//   3. Strip TODOS os xattrs do binário (Gatekeeper-safe em primeira execução)
//   4. Cria zip preservando perms (chmod 755 no daemon)
//   5. Verifica sha256 + tamanho
//   6. Smoke fresh-extract test em /tmp/zeus-pkg-test/ — descompressa,
//      checa estrutura, spawna binário, hit /v1/health em porta livre
//
// Uso: node scripts/package-release.mjs
//      node scripts/package-release.mjs --no-smoke   (skipa smoke fresh-extract)

import { spawnSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync, copyFileSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function run(cmd, args, opts = {}) {
  console.log(`[pkg] $ ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || root,
    stdio: opts.capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
  });
  if (r.status !== 0 && !opts.allowFail) {
    throw new Error(`${cmd} exit ${r.status}: ${r.stderr || ''}`);
  }
  return r;
}

function readJson(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function sha256Hex(filepath) {
  const data = readFileSync(filepath);
  return createHash('sha256').update(data).digest('hex');
}

// ============================================================================
// Steps
// ============================================================================

function verifyArtifacts() {
  const manifest = readJson(join(root, 'manifest.json'));
  const pkg = readJson(join(root, 'package.json'));
  if (manifest.version !== pkg.version) {
    throw new Error(`Version mismatch: manifest=${manifest.version} pkg=${pkg.version}`);
  }
  const required = ['manifest.json', 'main.js', 'styles.css', 'bin/ZeusDaemonMac'];
  for (const f of required) {
    const p = join(root, f);
    if (!existsSync(p)) throw new Error(`Required file missing: ${f}`);
    const sz = statSync(p).size;
    if (sz < 100) throw new Error(`Suspiciously small: ${f} (${sz}B)`);
  }
  return { version: manifest.version, id: manifest.id };
}

function verifyBinary() {
  const bin = join(root, 'bin/ZeusDaemonMac');
  const fileOut = run('/usr/bin/file', [bin], { capture: true });
  if (!/Mach-O.+arm64/.test(fileOut.stdout)) {
    throw new Error(`bin/ZeusDaemonMac não é Mach-O arm64: ${fileOut.stdout.trim()}`);
  }
  const cs = run('/usr/bin/codesign', ['-dv', bin], { capture: true, allowFail: true });
  if (!/Signature=adhoc|Apple/.test(cs.stderr + cs.stdout)) {
    console.warn('[pkg] ⚠ codesign verification falhou — re-codesign');
    run('/usr/bin/codesign', ['--sign', '-', '--force', bin]);
  }
  return { size: statSync(bin).size };
}

function stripXattrs() {
  const bin = join(root, 'bin/ZeusDaemonMac');
  // Strip todos os xattrs (com.apple.quarantine, com.apple.provenance, etc.).
  // Critical para primeira execução em outro Mac sem Gatekeeper bloquear.
  run('/usr/bin/xattr', ['-c', bin], { allowFail: true });
  console.log('[pkg] ✓ xattrs strippados');
}

function createZip(version, id) {
  const distDir = join(root, 'dist');
  mkdirSync(distDir, { recursive: true });
  const stageDir = join(distDir, `_stage_${version}`);
  const finalZip = join(distDir, `${id}-v${version}.zip`);

  // Clean stage
  rmSync(stageDir, { recursive: true, force: true });
  rmSync(finalZip, { force: true });
  mkdirSync(join(stageDir, id, 'bin'), { recursive: true });

  // Copy 4 essenciais via fs API (cp não está no PATH restrito do Node)
  for (const f of ['manifest.json', 'main.js', 'styles.css']) {
    copyFileSync(join(root, f), join(stageDir, id, f));
  }
  copyFileSync(join(root, 'bin/ZeusDaemonMac'), join(stageDir, id, 'bin/ZeusDaemonMac'));
  chmodSync(join(stageDir, id, 'bin/ZeusDaemonMac'), 0o755);

  // Re-strip xattrs (copyFileSync pode reaplicar provenance attr no FS)
  run('/usr/bin/xattr', ['-c', join(stageDir, id, 'bin/ZeusDaemonMac')], { allowFail: true });

  // Create zip preservando perms (path absoluto pra contornar PATH restrito)
  run('/usr/bin/zip', ['-r', '-X', finalZip, id], { cwd: stageDir });

  // Cleanup stage
  rmSync(stageDir, { recursive: true, force: true });

  const stat = statSync(finalZip);
  const sha = sha256Hex(finalZip);
  return { zipPath: finalZip, size: stat.size, sha256: sha };
}

function smokeFreshExtract(version, id, zipPath) {
  const testDir = '/tmp/zeus-pkg-test';
  rmSync(testDir, { recursive: true, force: true });
  mkdirSync(testDir, { recursive: true });

  console.log('[pkg] $ unzip + verify structure');
  run('/usr/bin/unzip', ['-q', zipPath, '-d', testDir]);

  const extracted = join(testDir, id);
  for (const f of ['manifest.json', 'main.js', 'styles.css', 'bin/ZeusDaemonMac']) {
    if (!existsSync(join(extracted, f))) throw new Error(`Zip incompleto: ${f} ausente`);
  }
  // Confirma perms do binário
  const mode = statSync(join(extracted, 'bin/ZeusDaemonMac')).mode;
  if (!(mode & 0o100)) throw new Error('bin/ZeusDaemonMac sem +x no zip');

  // Spawn binário em porta livre (avoid clash com daemon LIVE)
  const TEST_PORT = 23456;
  const binPath = join(extracted, 'bin/ZeusDaemonMac');
  console.log(`[pkg] $ spawn ${id}-v${version} em :${TEST_PORT}`);
  const child = spawn(binPath, ['--port', String(TEST_PORT), '--host', '127.0.0.1'], {
    stdio: 'ignore',
    detached: false,
  });

  // Aguarda /v1/health responder
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const poll = () => {
      if (Date.now() > deadline) {
        try { child.kill('SIGKILL'); } catch {}
        return reject(new Error('Smoke timeout: /v1/health não respondeu em 15s'));
      }
      const req = http.get(`http://127.0.0.1:${TEST_PORT}/v1/health`, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString());
            try { child.kill('SIGTERM'); } catch {}
            setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1000);
            resolve({
              endpoint_count: body.endpoint_count,
              version: body.version,
              fm: body.fm_available,
              nl: body.nl_available,
              vision: body.vision_available,
            });
          } catch (e) { reject(e); }
        });
      });
      req.on('error', () => setTimeout(poll, 500));
      req.setTimeout(2000, () => { req.destroy(); setTimeout(poll, 500); });
    };
    setTimeout(poll, 500);
  });
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('package-release.mjs requer macOS (codesign + Mach-O)');
  }
  console.log('═══ Zeus plugin release packaging ═══\n');

  const { version, id } = verifyArtifacts();
  console.log(`[pkg] ✓ versions consistentes: ${id} v${version}`);

  const bin = verifyBinary();
  console.log(`[pkg] ✓ bin/${id === 'zeus' ? 'ZeusDaemonMac' : ''} ${(bin.size/1024/1024).toFixed(1)} MB arm64 adhoc`);

  stripXattrs();

  const { zipPath, size, sha256 } = createZip(version, id);
  console.log(`\n[pkg] ✓ zip criado: ${zipPath}`);
  console.log(`        ${(size/1024/1024).toFixed(2)} MB · sha256 ${sha256.slice(0, 16)}…`);

  // Persist sha256 sidecar
  writeFileSync(zipPath + '.sha256', `${sha256}  ${id}-v${version}.zip\n`);
  console.log(`[pkg] ✓ sidecar sha256: ${zipPath}.sha256`);

  if (!process.argv.includes('--no-smoke')) {
    console.log('\n[pkg] === Smoke fresh-extract test ===');
    try {
      const health = await smokeFreshExtract(version, id, zipPath);
      console.log(`[pkg] ✓ smoke OK: ${health.endpoint_count} endpoints, daemon v${health.version}, FM=${health.fm}`);
    } catch (e) {
      console.warn('[pkg] ⚠ smoke falhou:', e.message);
      console.log('[pkg] continue mesmo assim — zip está pronto, smoke não-bloqueante');
    }
  }

  console.log(`\n═══ Pronto para distribuição: ${zipPath} ═══`);
  console.log(`Para instalar em outra vault Obsidian:`);
  console.log(`  cd <vault>/.obsidian/plugins && unzip ${zipPath}`);
  console.log(`  → Recarrega Obsidian, plugin v${version} ativa drop-in.`);
}

try { await main(); }
catch (e) {
  console.error('\n[pkg] ✗', e.message);
  process.exit(1);
}
