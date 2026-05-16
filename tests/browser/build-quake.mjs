// Build script for the browser Quake test: compile vendor/quake/src/*.c
// into tests/browser/www/quake.wasm and copy pak0.pak + host.js next to
// it so the static server has everything it needs.
//
// Run via `npm run build:quake` (or directly: `node build-quake.mjs`).
import { execSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const SRC_DIR = path.join(ROOT, 'vendor', 'quake', 'src');
const DATA_DIR = path.join(ROOT, 'vendor', 'quake', 'data');
const WWW = path.join(__dirname, 'www');
const COMPILER = path.join(ROOT, 'compiler.js');
const HOST_JS = path.join(ROOT, 'host.js');

fs.mkdirSync(WWW, { recursive: true });

console.log(`[build] Compiling Quake → ${WWW}/quake.wasm ...`);
const srcFiles = fs.readdirSync(SRC_DIR)
  .filter(f => f.endsWith('.c'))
  .map(f => path.join(SRC_DIR, f));

// Our compiler's -I parses as an attached prefix (`-Ipath`), not `-I path`.
const result = spawnSync('node', [
  COMPILER,
  '--allow-old-c',
  `-I${SRC_DIR}`,
  '-o', path.join(WWW, 'quake.wasm'),
  ...srcFiles,
], { stdio: 'inherit' });
if (result.status !== 0) {
  console.error(`[build] compiler exited ${result.status}`);
  process.exit(1);
}

console.log('[build] Copying pak0.pak and host.js ...');
fs.copyFileSync(
  path.join(DATA_DIR, 'id1', 'pak0.pak'),
  path.join(WWW, 'pak0.pak'),
);
fs.copyFileSync(HOST_JS, path.join(WWW, 'host.js'));

const wasmSize = fs.statSync(path.join(WWW, 'quake.wasm')).size;
const pakSize  = fs.statSync(path.join(WWW, 'pak0.pak')).size;
console.log(`[build] OK — quake.wasm=${wasmSize} bytes, pak0.pak=${pakSize} bytes`);
