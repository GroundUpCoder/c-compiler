#!/usr/bin/env node
// imgbrtables.js — census every `br_table` in every wasm binary inside a
// baked BlockFS image, so "did todos/0332 change anything a user runs?" is a
// measurement rather than a guess.
//
// Why the entry count answers that question exactly. compiler.js lowers a
// switch to a jump table only when
//     nonDefaultCount >= 4  &&  range <= MAX_BR_TABLE_RANGE  &&  density >= 40%
// and the emitted table has exactly `range` entries (CodeGenerator, the
// `dense` block). 0332 moved that cap 512 -> 65520 and touched nothing else,
// so a br_table with MORE than 512 entries is, by construction, a switch that
// the old compiler would have emitted as a linear br_if chain of
// `nonDefaultCount` compares instead. Counting them IS counting the fix's
// beneficiaries.
//
//   node imgbrtables.js <image.img> [--cap=512] [--all] [--quiet]
//
// --all also prints the full size histogram (not just the over-cap tables).
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const { BLOCK_FS } = require(path.join(ROOT, 'host.js'));
const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
const S = require(path.join(__dirname, 'wasmscan.js'));

let img = null, cap = 512, all = false, quiet = false;
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--cap=')) cap = parseInt(a.slice(6), 10);
  else if (a === '--all') all = true;
  else if (a === '--quiet') quiet = true;
  else img = a;
}
if (!img) { console.error('usage: imgbrtables.js <image.img> [--cap=N] [--all]'); process.exit(2); }

const store = new COMMON.NodeFileStore(fs, img, false);
const vol = BLOCK_FS.createV4(store, { readonly: true });

// ── walk the whole tree, collecting regular files (symlinks not followed:
// a /bin symlink would double-count its target) ──
const files = [];
(function walk(dir) {
  const dh = vol.opendir(dir);
  if (dh < 0) return;
  const names = [];
  for (;;) { const e = vol.readdir(dh); if (!e) break; names.push(e.name); }
  vol.closedir(dh);
  for (const n of names) {
    if (n === '.' || n === '..') continue;
    const p = dir === '/' ? '/' + n : dir + '/' + n;
    const st = vol.lstat(p);
    if (!st) continue;
    const mode = st.mode & 0o170000;
    if (mode === 0o040000) walk(p);
    else if (mode === 0o100000) files.push({ path: p, size: st.size });
  }
})('/');

function readAll(p, size) {
  const fd = vol.open(p, 0);
  if (fd < 0) return null;
  const out = Buffer.alloc(size);
  let got = 0;
  while (got < size) {
    // POSIX-shaped: read(fd, dstBuf, count) -> bytes read. Loop it — a short
    // read is legal (todos/0140 was exactly this bug in RemoteFS).
    const n = vol.read(fd, out.subarray(got), size - got);
    if (!(n > 0)) break;
    got += n;
  }
  vol.close(fd);
  return got === size ? out : out.subarray(0, got);
}

const MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
const rows = [];          // one per over-cap br_table
const hist = new Map();   // bucket -> count, over ALL br_tables
let nWasm = 0, nTables = 0, totalBytes = 0, failed = [];

for (const f of files) {
  if (f.size < 8) continue;
  const buf = readAll(f.path, f.size);
  if (!buf || buf.length < 8 || !buf.subarray(0, 4).equals(MAGIC)) continue;
  nWasm++; totalBytes += buf.length;
  let m;
  try { m = S.parse(buf); } catch (e) { failed.push(f.path + ': ' + e.message); continue; }
  for (let k = 0; k < m.code.length; k++) {
    const fi = k + m.importedFuncs;
    let r;
    try { r = S.bodyRange(m, fi); } catch (e) { continue; }
    if (!r) continue;
    try {
      for (const ins of S.walk(buf, r.code, r.end)) {
        if (ins.op !== 0x0e) continue;              // br_table
        const entries = ins.imm.length - 1;         // imm = targets + default
        nTables++;
        const b = entries > 65520 ? '>65520' : entries > 4096 ? '4097-65520'
          : entries > 512 ? '513-4096' : entries > 128 ? '129-512'
            : entries > 16 ? '17-128' : '1-16';
        hist.set(b, (hist.get(b) || 0) + 1);
        if (entries > cap) {
          // How big was the chain this replaced? The old lowering emitted one
          // `local.get/i32.const/i32.eq/br_if` quad per NON-DEFAULT case, i.e.
          // per table slot that is not the default target.
          const dflt = ins.imm[ins.imm.length - 1];
          let nonDefault = 0;
          for (let t = 0; t < entries; t++) if (ins.imm[t] !== dflt) nonDefault++;
          rows.push({
            file: f.path, fi, name: m.names.get(fi) || null,
            entries, nonDefault, funcBytes: m.code[k].size,
          });
        }
      }
    } catch (e) { failed.push(`${f.path} #${fi}: ${e.message}`); }
  }
}

rows.sort((a, b) => b.entries - a.entries);
if (!quiet) {
  console.log(`image: ${img}`);
  console.log(`files: ${files.length} regular, ${nWasm} wasm (${(totalBytes / 1048576).toFixed(1)} MiB of wasm)`);
  console.log(`br_tables: ${nTables} total`);
  if (all) console.log('  size buckets: ' + [...hist].sort().map(([k, v]) => `${k}:${v}`).join('  '));
  console.log(`OVER CAP ${cap}: ${rows.length} br_table(s)` + (rows.length ? '' : '  <- nothing in this image needs the raised cap'));
  for (const r of rows) {
    console.log(`  ${r.file}  func #${r.fi}${r.name ? ' ' + r.name : ''}  entries=${r.entries}  non-default=${r.nonDefault}  funcbytes=${r.funcBytes}`);
  }
  for (const e of failed.slice(0, 10)) console.log('  ! ' + e);
  if (failed.length > 10) console.log(`  ! (+${failed.length - 10} more decode failures)`);
}
// A scan that found no wasm at all is a BROKEN SCAN, not an empty image, and
// "0 over cap" would read as a real answer. Fail loud instead.
if (nWasm === 0) {
  console.error('imgbrtables: found 0 wasm binaries — the walk or the reader is broken, NOT a result');
  process.exit(3);
}
process.exit(0);
