import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: options.cwd || root,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
  });
  if (result.status !== 0) {
    if (options.capture) {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
    }
    throw new Error(`${cmd} ${args.join(' ')} failed with exit ${result.status}`);
  }
  return result.stdout || '';
}

function listFiles(dir, predicate, ignored = new Set(['.git', 'node_modules', '.build', 'graphify-out'])) {
  const out = [];
  function walk(current) {
    for (const name of readdirSync(current)) {
      if (ignored.has(name)) continue;
      const abs = join(current, name);
      const st = statSync(abs);
      if (st.isDirectory()) walk(abs);
      else if (predicate(abs)) out.push(abs);
    }
  }
  walk(dir);
  return out;
}

function validateJson(files) {
  for (const file of files) JSON.parse(readFileSync(file, 'utf8'));
}

function checkEndpointContracts() {
  const client = readFileSync(join(root, 'lib/zeus-http-client.js'), 'utf8');
  const clientEndpoints = new Set();
  for (const match of client.matchAll(/_post\('([^']+)'/g)) {
    if (match[1].startsWith('/')) clientEndpoints.add(match[1]);
  }
  for (const match of client.matchAll(/url: `\$\{this\.baseUrl\}([^`]+)`/g)) {
    if (match[1].startsWith('/')) clientEndpoints.add(match[1]);
  }

  const servers = [
    'daemon/Sources/ZeusDaemonMac/ZeusMacHTTPHandler.swift',
    'daemon/Sources/AegisDaemon/AegisHTTPHandlers.swift',
  ];
  for (const rel of servers) {
    const source = readFileSync(join(root, rel), 'utf8');
    const serverEndpoints = new Set();
    for (const match of source.matchAll(/case \(\.(GET|POST), "([^"]+)"\)/g)) {
      serverEndpoints.add(match[2]);
    }
    const missing = [...clientEndpoints].filter((endpoint) => !serverEndpoints.has(endpoint)).sort();
    if (missing.length) {
      throw new Error(`${rel} missing client endpoints: ${missing.join(', ')}`);
    }
  }
}

function main() {
  run('bun', ['run', 'build']);

  for (const file of listFiles(root, (abs) => ['.js', '.mjs'].includes(extname(abs)))) {
    run('node', ['--check', file]);
  }

  validateJson([
    join(root, 'package.json'),
    join(root, 'manifest.json'),
    join(root, 'data.json'),
    join(root, 'daemon/Package.resolved'),
    ...listFiles(join(root, 'daemon/Sources/AegisDaemon/Resources/FewShotExamples'), (abs) => extname(abs) === '.json'),
  ].filter(existsSync));

  for (const file of listFiles(root, (abs) => extname(abs) === '.sh')) {
    run('bash', ['-n', file]);
  }
  if (process.platform === 'darwin') {
    run('plutil', ['-lint', 'daemon/scripts/com.maiocchi.zeusdaemon.plist']);
  }

  checkEndpointContracts();

  // v1.5 — autonomia: validate bundled daemon binary
  const daemonBin = join(root, 'bin/ZeusDaemonMac');
  if (!existsSync(daemonBin)) {
    throw new Error(`bin/ZeusDaemonMac ausente — rode: node scripts/build-release.mjs`);
  }
  const stat = statSync(daemonBin);
  if (!(stat.mode & 0o111)) {
    throw new Error(`bin/ZeusDaemonMac não é executável (mode ${stat.mode.toString(8)})`);
  }
  if (stat.size < 1_000_000) {
    throw new Error(`bin/ZeusDaemonMac suspeito (${stat.size}B) — esperado >1MB`);
  }

  run('swift', ['build', '-c', 'debug', '--product', 'ZeusDaemonMac'], { cwd: join(root, 'daemon') });
  run('swift', ['build', '-c', 'debug', '--target', 'AegisDaemon'], { cwd: join(root, 'daemon') });

  console.log('[check-project] OK');
}

try {
  main();
} catch (error) {
  console.error(`[check-project] ${error.message}`);
  process.exit(1);
}
