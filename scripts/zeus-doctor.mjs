#!/usr/bin/env node
// zeus-doctor.mjs — health check da stack Zeus em N camadas (padrão ios-control-mcp).
//
// Verifica e reporta cada camada com:
//   OK  / !!  / XX  + comando de fix por falha.
// Exit 0 = tudo OK; 2 = warnings; 1 = falhas. CI-friendly.

import { existsSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const checks = [];
function add(layer, status, detail, fix) { checks.push({ layer, status, detail, fix }); }

function checkBinary() {
  const bin = join(root, 'bin/ZeusDaemonMac');
  if (!existsSync(bin)) return add('bin/ZeusDaemonMac', 'XX', 'binário ausente', 'node scripts/build-release.mjs');
  const st = statSync(bin);
  if (!(st.mode & 0o111)) return add('bin/ZeusDaemonMac', 'XX', `não executável (mode ${st.mode.toString(8)})`, 'chmod +x bin/ZeusDaemonMac');
  if (st.size < 1_000_000) return add('bin/ZeusDaemonMac', '!!', `tamanho suspeito ${(st.size/1024).toFixed(0)} KB`, 'node scripts/build-release.mjs');
  add('bin/ZeusDaemonMac', 'OK', `${(st.size/1024/1024).toFixed(1)} MB executável`);
}

function checkCodesign() {
  const bin = join(root, 'bin/ZeusDaemonMac');
  if (!existsSync(bin)) return;
  const r = spawnSync('/usr/bin/codesign', ['-dv', bin], { encoding: 'utf8' });
  const out = (r.stderr || r.stdout || '');
  if (/Signature=adhoc|Signature=Apple/.test(out)) {
    add('codesign', 'OK', /adhoc/.test(out) ? 'adhoc (ad-hoc signed)' : 'Apple signed');
  } else if (r.status === 0) {
    add('codesign', '!!', 'binário não-assinado — Gatekeeper pode bloquear', 'codesign --sign - --force bin/ZeusDaemonMac');
  } else {
    add('codesign', '!!', out.trim().split('\n')[0] || 'codesign falhou', 'codesign --sign - --force bin/ZeusDaemonMac');
  }
}

function checkMainJs() {
  const f = join(root, 'main.js');
  if (!existsSync(f)) return add('main.js', 'XX', 'ausente — esbuild não rodou', 'node esbuild.config.mjs');
  const size = statSync(f).size;
  if (size < 50_000) return add('main.js', '!!', `${(size/1024).toFixed(0)} KB — esperado >100KB`, 'node esbuild.config.mjs');
  add('main.js', 'OK', `${(size/1024).toFixed(0)} KB`);
}

function checkManifests() {
  for (const file of ['manifest.json', 'package.json']) {
    const p = join(root, file);
    if (!existsSync(p)) { add(file, 'XX', 'ausente', `restore ${file}`); continue; }
    try {
      const j = JSON.parse(readFileSync(p, 'utf8'));
      add(file, 'OK', `version ${j.version}`);
    } catch (e) {
      add(file, 'XX', 'JSON inválido: ' + e.message.slice(0, 60), 'fix JSON manually');
    }
  }
}

function httpGet(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', () => resolve(null));
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
  });
}

async function checkDaemon() {
  const r = await httpGet('http://127.0.0.1:2223/v1/health');
  if (!r) return add('daemon HTTP', '!!', 'sem resposta em 127.0.0.1:2223', 'plugin do Obsidian sobe sozinho ao carregar; ou rode bin/ZeusDaemonMac manualmente');
  if (r.status !== 200) return add('daemon HTTP', '!!', `status ${r.status}`, 'kill -9 $(lsof -ti:2223) e relançar');
  try {
    const h = JSON.parse(r.body);
    const flags = [
      h.fm_available ? 'FM✓' : 'FM✗',
      h.nl_available ? 'NL✓' : 'NL✗',
      h.vision_available ? 'Vision✓' : 'Vision✗',
      h.speech_available ? 'Speech✓' : 'Speech',
    ].join(' ');
    const ok = h.fm_available && h.nl_available;
    add('daemon HTTP', ok ? 'OK' : '!!', `v${h.version || '?'} ${h.platform} · ${flags}`,
      ok ? null : 'Habilite Apple Intelligence em System Settings');
  } catch {
    add('daemon HTTP', '!!', 'response não-JSON', 'verifique /tmp/zeusdaemon.err.log');
  }
}

function checkMacOS() {
  if (process.platform !== 'darwin') { add('macOS', '!!', `plataforma ${process.platform} — Mac required`); return; }
  const r = spawnSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' });
  const ver = (r.stdout || '').trim();
  const major = parseInt(ver.split('.')[0], 10);
  if (major >= 26) add('macOS', 'OK', `${ver} (Apple Intelligence elegível)`);
  else if (major >= 15) add('macOS', '!!', `${ver} — FM disponível mas Speech assets podem precisar de macOS 26+`);
  else add('macOS', 'XX', `${ver} — FoundationModels requer macOS 15+`, 'atualize o macOS');
}

async function main() {
  console.log('zeus doctor — stack overview');
  console.log('='.repeat(36));
  console.log();
  checkMacOS();
  checkBinary();
  checkCodesign();
  checkMainJs();
  checkManifests();
  await checkDaemon();

  let ok = 0, warn = 0, fail = 0;
  for (const c of checks) {
    console.log(`${c.status}  ${c.layer.padEnd(22)} ${c.detail}`);
    if (c.fix && c.status !== 'OK') console.log(`    fix: ${c.fix}`);
    if (c.status === 'OK') ok++;
    else if (c.status === '!!') warn++;
    else fail++;
  }
  console.log();
  console.log(`resumo: ${ok} OK, ${warn} WARN, ${fail} FAIL (de ${checks.length} layers)`);
  process.exit(fail ? 1 : (warn ? 2 : 0));
}

main();
