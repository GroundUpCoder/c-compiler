// Build script for the browser Doom test: compile vendor/doom/bin.json into
// a self-contained .html page under tests/browser/www/ —
//   doom.html      compiled with the BLOCK_FS backend (the only browser backend)
// so doom-renders.mjs can screenshot it and confirm it renders.
//
// The doom1.wad data file is bundled into the page automatically via the
// project's `dataFiles` entry in bin.json.
//
// Run via `pnpm run build:doom` (or directly: `node build-doom.mjs`).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const BIN_JSON = path.join(ROOT, 'vendor', 'doom', 'bin.json');
const WWW = path.join(__dirname, 'www');
const COMPILER = path.join(ROOT, 'compiler.js');

fs.mkdirSync(WWW, { recursive: true });

function compile(outName, extraArgs) {
  const out = path.join(WWW, outName);
  console.log(`[build] Compiling Doom → ${out} ${extraArgs.join(' ')} ...`);
  const r = spawnSync('node',
    [COMPILER, BIN_JSON, '-o', out, '--no-version-check', ...extraArgs],
    { stdio: 'inherit' });
  if (r.status !== 0) { console.error(`[build] compiler exited ${r.status}`); process.exit(1); }
  console.log(`[build] OK — ${outName} = ${fs.statSync(out).size} bytes`);
}

compile('doom.html', []);                 // BLOCK_FS backend
