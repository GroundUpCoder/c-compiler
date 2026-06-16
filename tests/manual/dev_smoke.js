#!/usr/bin/env node
// End-to-end /dev smoke test: compiles tests/manual/dev_smoke.c with the real
// compiler and runs it against a fresh v4 BLOCK_FS (which auto-creates /dev),
// asserting the program's self-reported results. Lives in tests/manual/ (not
// the unit suite) because /dev is v4-only — see the note in dev_smoke.c.
//
//   node tests/manual/dev_smoke.js

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');

const compiler = require(path.join(ROOT, 'compiler.js'));
const runModule = require(path.join(ROOT, 'host.js'));
const BLOCK_FS = runModule.BLOCK_FS;

function fail(m) { console.error(`FAIL: ${m}`); process.exit(1); }

async function main() {
  const cFile = path.join(__dirname, 'dev_smoke.c');
  const pp = compiler.createDefaultPPRegistry();
  pp.fileReader = (p) => { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } };
  const compilerOptions = {
    debugSwitch: false, allowImplicitInt: false, allowEmptyParams: false,
    allowKnRDefinitions: false, allowImplicitFunctionDecl: false,
    allowUndefined: false, gcSections: false, gcNoExportRoots: false,
    noUndefined: false, requireSources: [], backend: 'default',
  };
  const warningFlags = { pointerDecay: false, circularDependency: false, largeStackFrame: false };
  const errBuf = [];
  const writeErr = (s) => errBuf.push(Buffer.from(s));

  let wasm;
  try {
    const units = compiler.parseAllUnits(fs, pp, [path.relative(ROOT, cFile)], { warningFlags, compilerOptions, writeErr });
    const link = compiler.linkTranslationUnits(units, compilerOptions);
    if (link.errors.length) fail(`link errors:\n${link.errors.map(e => e.message).join('\n')}`);
    wasm = compiler.generateCode(units, 'dev_smoke.wasm', { compilerOptions, warningFlags, writeErr });
  } catch (e) {
    fail(`compile threw: ${e.message}\n${Buffer.concat(errBuf)}`);
  }

  const store = new BLOCK_FS.MemoryByteStore(1 << 20);
  const blockFS = BLOCK_FS.createV4(store);
  const out = [];
  const exitCode = await runModule({
    bytes: wasm, args: ['dev_smoke.wasm'], env: {},
    writeOut: (b) => out.push(Buffer.from(b)),
    writeErr: (b) => out.push(Buffer.from(b)),
    blockFsFactory: async (ctx) => ({ c: blockFS.toWasmEnv(ctx) }),
  });
  const stdout = Buffer.concat(out).toString('utf-8');
  process.stdout.write(stdout.replace(/^/gm, '  | '));

  const want = [
    'zero_ischr 1', 'zero_dev 1:5', 'zero_read_ok 1',
    'null_write 1', 'null_eof 1', 'urandom_varied 1', 'DONE',
  ];
  for (const line of want) if (!stdout.includes(line)) fail(`missing output line: "${line}"`);
  if (exitCode !== 0) fail(`program exited ${exitCode}`);
  console.log('PASS');
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
