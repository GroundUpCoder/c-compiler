// Build + run the charset probe under host.js.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const require = createRequire(import.meta.url);

const OS_COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
const CompilerJS = require(path.join(ROOT, 'compiler.js'));

console.log('building xp/nscharset/bin.json …');
const t0 = Date.now();
const bytes = OS_COMMON.buildProject(
  CompilerJS,
  'xp/nscharset/bin.json',
  (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8'),
);
const OUT = path.join(ROOT, 'build', 'nscharset');
fs.mkdirSync(OUT, { recursive: true });
const WASM = path.join(OUT, 'probe.wasm');
fs.writeFileSync(WASM, bytes);
console.log(`built ${WASM} (${(bytes.length / 1024).toFixed(0)} KB) in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

const child = spawn(process.execPath, [path.join(ROOT, 'host.js'), WASM], { stdio: 'inherit' });
child.on('exit', (c) => process.exit(c ?? 1));
