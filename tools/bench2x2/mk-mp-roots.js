#!/usr/bin/env node
// bench-2x2: materialise MicroPython build roots at the two heap sizes the
// spec requires (256 KB and the 32 MB R1 target), WITHOUT touching the
// vendored tree.
//
// vendor/micropython/mpconfigport.h hard-#defines MICROPY_HEAP_SIZE inside
// `#ifdef __wasm__`, so it cannot be overridden with -D. Each root is a copy
// with exactly that one line rewritten.
//
//   node mk-mp-roots.js <vendor/micropython> <outdir>
const fs = require('fs');
const path = require('path');

const [, , srcDir, outDir] = process.argv;
if (!srcDir || !outDir) { console.error('usage: mk-mp-roots.js <vendor/micropython> <outdir>'); process.exit(2); }

const HEAPS = { '256k': 256 * 1024, '32m': 32 * 1024 * 1024 };

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, e.name), d = path.join(to, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else if (e.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(s), d);
    else fs.copyFileSync(s, d);
  }
}

// The vendored line, verbatim, is the anchor. If it ever moves this throws
// rather than silently building two identical heaps.
const ANCHOR = '#define MICROPY_HEAP_SIZE      (33554432) // heap size 32 megabytes';

for (const [tag, bytes] of Object.entries(HEAPS)) {
  const root = path.join(outDir, 'mp-' + tag);
  fs.rmSync(root, { recursive: true, force: true });
  copyTree(srcDir, root);

  const cfg = path.join(root, 'mpconfigport.h');
  let s = fs.readFileSync(cfg, 'utf8');
  if (s.indexOf(ANCHOR) < 0) throw new Error('heap anchor not found in ' + cfg);
  if (s.indexOf(ANCHOR) !== s.lastIndexOf(ANCHOR)) throw new Error('heap anchor is not unique');
  s = s.replace(ANCHOR, '#define MICROPY_HEAP_SIZE      (' + bytes + ') // bench-2x2: ' + tag);
  fs.writeFileSync(cfg, s);

  // Verify the wasm arm really carries the intended number.
  const got = /#define MICROPY_HEAP_SIZE\s+\((\d+)\) \/\/ bench-2x2/.exec(fs.readFileSync(cfg, 'utf8'));
  if (!got || Number(got[1]) !== bytes) throw new Error('heap rewrite did not take for ' + tag);
  console.log('mp-' + tag + ': MICROPY_HEAP_SIZE = ' + bytes + ' (' + (bytes / 1024) + ' KB)  -> ' + root);
}
