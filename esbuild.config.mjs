// esbuild config — bundles main.source.js + lib/*.js into a single main.js.
// Needed because Obsidian mobile (iOS / Capacitor) cannot resolve disk files
// via require(); the desktop-only pluginRequire('lib/X') indirection is dead.
//
// `obsidian` and the Node builtins MUST stay external: they are require'd with
// guarded try/catch — on desktop they resolve to the real Node, on iOS they
// throw and are swallowed. Embedding them would break that contract.
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['main.source.js'],
  outfile: 'main.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2018',
  logLevel: 'info',
  external: [
    'obsidian',
    'electron',
    'fs',
    'path',
    'os',
    'child_process',
    'crypto',
    'http',
    'https',
    'net',
    'tls',
    'stream',
    'util',
    'events',
    'url',
    'zlib',
    'dgram',
    'worker_threads',
    '@codemirror/*',
    '@lezer/*',
  ],
});
