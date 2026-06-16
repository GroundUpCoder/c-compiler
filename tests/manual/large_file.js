#!/usr/bin/env node
// Standalone >4 GiB BLOCK_FS v4 large-file exercise. Lives under tests/manual/
// (not tests/blockfs/) so neither run.js's explicit list nor run.py's *.js glob
// picks it up — it allocates multi-GiB buffers and takes tens of seconds.
//
// Run it explicitly:
//   node tests/manual/large_file.js               # ~4.06 GiB file (default)
//   LARGE_FILE_BYTES=5368709120 node tests/manual/large_file.js   # 5 GiB
//
// It compiles tests/manual/large_file.c with the real compiler, runs it
// against a pre-sized v4 MemoryByteStore, asserts the program's self-verifying
// output, then fsck's the resulting image and re-mounts it to confirm the
// 64-bit size survives a fresh mount (read-through coherence).

'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');

const compiler = require(path.join(ROOT, 'compiler.js'));
const runModule = require(path.join(ROOT, 'host.js'));
const BLOCK_FS = runModule.BLOCK_FS;
const { assertFsck } = require('../blockfs/fsck_v4.js');

const GiB = 1024 * 1024 * 1024;
const DEFAULT_BYTES = 4 * GiB + 64 * 1024 * 1024; // just over the 2^32 boundary
const TARGET_BYTES = Number(process.env.LARGE_FILE_BYTES || DEFAULT_BYTES);
if (!Number.isInteger(TARGET_BYTES) || TARGET_BYTES <= 4 * GiB) {
  console.error(`LARGE_FILE_BYTES must be an integer > 4 GiB (got ${TARGET_BYTES})`);
  process.exit(1);
}
// Headroom for inode table, root dir extent, TLSF metadata, and the block
// overhead on the one big extent. The single data extent itself is TARGET_BYTES.
const STORE_BYTES = TARGET_BYTES + 128 * 1024 * 1024;

function fail(msg) { console.error(`FAIL: ${msg}`); process.exit(1); }

async function main() {
  const human = (TARGET_BYTES / GiB).toFixed(3);
  console.log(`large_file: target ${TARGET_BYTES} bytes (${human} GiB), store ${(STORE_BYTES / GiB).toFixed(3)} GiB`);

  // ---- Compile tests/blockfs/large_file.c with TARGET_BYTES injected ----
  const cFile = path.join(__dirname, 'large_file.c');
  const pp = compiler.createDefaultPPRegistry();
  pp.fileReader = (p) => { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } };
  pp.defines.set('TARGET_BYTES', `${TARGET_BYTES}ULL`);

  const compilerOptions = {
    debugSwitch: false, allowImplicitInt: false, allowEmptyParams: false,
    allowKnRDefinitions: false, allowImplicitFunctionDecl: false,
    allowUndefined: false, gcSections: false, gcNoExportRoots: false,
    noUndefined: false, requireSources: [], backend: 'default',
  };
  const warningFlags = { pointerDecay: false, circularDependency: false, largeStackFrame: false };

  const stderrChunks = [];
  const writeErr = (s) => stderrChunks.push(Buffer.from(s));
  let wasmBinary;
  try {
    const units = compiler.parseAllUnits(fs, pp, [path.relative(ROOT, cFile)], {
      warningFlags, compilerOptions, writeErr,
    });
    const link = compiler.linkTranslationUnits(units, compilerOptions);
    if (link.errors.length) fail(`link errors:\n${link.errors.map(e => e.message).join('\n')}`);
    wasmBinary = compiler.generateCode(units, 'large_file.wasm', { compilerOptions, warningFlags, writeErr });
  } catch (e) {
    fail(`compile threw: ${e.message}\n${Buffer.concat(stderrChunks)}`);
  }
  console.log(`compiled (${wasmBinary.length} bytes wasm)`);

  // ---- Pre-size the store and mount a fresh v4 image ----
  const t0 = Date.now();
  const store = new BLOCK_FS.MemoryByteStore(STORE_BYTES);
  const blockFS = BLOCK_FS.createV4(store);

  // ---- Run the program against the live store ----
  const out = [];
  const exitCode = await runModule({
    bytes: wasmBinary,
    args: ['large_file.wasm'],
    env: {},
    writeOut: (b) => out.push(Buffer.from(b)),
    writeErr: (b) => out.push(Buffer.from(b)),
    blockFsFactory: async (ctx) => ({ c: blockFS.toWasmEnv(ctx) }),
  });
  const stdout = Buffer.concat(out).toString('utf-8');
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  process.stdout.write(stdout.replace(/^/gm, '  | '));
  console.log(`program exit ${exitCode}  (${elapsed}s)`);

  // ---- Assert the program's self-reported results ----
  const want = [
    `size ${TARGET_BYTES}`,
    'size_ok 1',
    'read_verify_ok 1',
    'spot_ok 1',
    'DONE',
  ];
  for (const line of want) {
    if (!stdout.includes(line)) fail(`expected output line missing: "${line}"`);
  }
  if (exitCode !== 0) fail(`program exited ${exitCode}`);

  // ---- Structural integrity + read-through coherence on a fresh mount ----
  assertFsck(store, `${human} GiB`);
  const remount = BLOCK_FS.createV4(store);
  const st = remount.stat('/big.bin');
  if (!st) fail('re-mount: /big.bin not found');
  if (st.size !== TARGET_BYTES) fail(`re-mount: size ${st.size} != ${TARGET_BYTES}`);
  console.log(`fsck clean; re-mounted size ${st.size} ✓`);

  console.log('PASS');
}

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
