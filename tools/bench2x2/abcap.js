#!/usr/bin/env node
// abcap.js — build one bin.json project TWICE, with MAX_BR_TABLE_RANGE at the
// post-0332 value and at the pre-0332 value, and diff the two artifacts.
//
// This is the controlled counterpart to imgbrtables.js's static census: rather
// than infer "the old compiler would have emitted a chain here", it produces
// the old compiler's actual output. compiler.js is never modified on disk —
// its source is read, the ONE constant is rewritten in memory, and the result
// is evaluated as a private module and handed to os-common.buildProject, which
// already takes the compiler as a parameter.
//
//   node abcap.js <project.json> [--old=512] [--out=DIR]
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');
const ROOT = path.resolve(__dirname, '..', '..');
const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));
const S = require(path.join(__dirname, 'wasmscan.js'));

let proj = null, oldCap = 512, outDir = '/tmp/v177m';
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--old=')) oldCap = parseInt(a.slice(6), 10);
  else if (a.startsWith('--out=')) outDir = a.slice(6);
  else proj = a;
}
if (!proj) { console.error('usage: abcap.js <project.json> [--old=N]'); process.exit(2); }

const SRC = path.join(ROOT, 'compiler.js');
const text = fs.readFileSync(SRC, 'utf-8');
const DECL = 'const MAX_BR_TABLE_RANGE = 65520;';
if (!text.includes(DECL)) {
  console.error(`abcap: could not find "${DECL}" in compiler.js — refusing to guess`);
  process.exit(2);
}

function loadCompiler(cap) {
  const patched = cap === 65520 ? text
    : text.replace(DECL, `const MAX_BR_TABLE_RANGE = ${cap};`);
  if (cap !== 65520 && patched === text) throw new Error('patch was a no-op');
  const m = new Module(SRC, null);
  m.filename = SRC;
  m.paths = Module._nodeModulePaths(path.dirname(SRC));
  m._compile(patched, SRC);
  return m.exports;
}

const readHostFile = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8');

function census(buf, label) {
  const m = S.parse(buf);
  const tables = [];
  let chainMax = 0, chainTot = 0, chains = 0;
  for (let k = 0; k < m.code.length; k++) {
    const fi = k + m.importedFuncs;
    const r = S.bodyRange(m, fi);
    if (!r) continue;
    const ins = [...S.walk(buf, r.code, r.end)];
    for (const x of ins) if (x.op === 0x0e) tables.push({ fi, entries: x.imm.length - 1 });
    // linear compare-chain detection, same shape as cmpchain.js
    let i = 0;
    while (i < ins.length) {
      let j = i, local = null, len = 0;
      while (j + 3 < ins.length) {
        const [a, b, c, d] = [ins[j], ins[j + 1], ins[j + 2], ins[j + 3]];
        if (a.name !== 'local.get' || b.name !== 'i32.const') break;
        if (c.name !== 'i32.eq' && c.name !== 'i32.ne') break;
        if (d.name !== 'br_if' && d.name !== 'if') break;
        if (local === null) local = a.imm; else if (a.imm !== local) break;
        len++; j += 4;
        if (d.name === 'if') break;
      }
      if (len >= 3) { chains++; chainTot += len; if (len > chainMax) chainMax = len; i = j; } else i++;
    }
  }
  const over = tables.filter((t) => t.entries > oldCap);
  console.log(`${label}: ${buf.length} bytes, ${m.code.length} funcs, ${tables.length} br_tables ` +
    `(${over.length} with >${oldCap} entries), ${chains} compare-chains / ${chainTot} compares, longest chain ${chainMax}`);
  for (const t of over) console.log(`    br_table func #${t.fi} entries=${t.entries}`);
  return { tables, over, chains, chainTot, chainMax, size: buf.length };
}

fs.mkdirSync(outDir, { recursive: true });
const name = path.basename(proj).replace(/\.json$/, '');
const results = {};
for (const cap of [65520, oldCap]) {
  const C = loadCompiler(cap);
  const t0 = Date.now();
  const wasm = COMMON.buildProject(C, proj, readHostFile);
  const buf = Buffer.from(wasm);
  const f = path.join(outDir, `${name}.cap${cap}.wasm`);
  fs.writeFileSync(f, buf);
  results[cap] = census(buf, `cap=${cap}`.padEnd(12));
  console.log(`    -> ${f}  (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
const a = results[65520], b = results[oldCap];
console.log(`\ndelta (new - old): size ${a.size - b.size} bytes, ` +
  `br_tables ${a.tables.length - b.tables.length}, chain compares ${a.chainTot - b.chainTot}`);
