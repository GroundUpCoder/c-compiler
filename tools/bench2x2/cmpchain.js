#!/usr/bin/env node
// cmpchain.js — find linear compare-chain dispatch in an emitted wasm function.
//
// A "chain" here is a run of  local.get L ; i32.const K ; i32.eq ; br_if/if
// against the SAME local L. That is the shape a switch (or a state-machine
// dispatch) takes when it is lowered as a linear scan instead of a br_table,
// and its cost is O(chain length) per taken edge. Written for todos/0332.
'use strict';
const path = require('path');
const S = require(path.join(__dirname, 'wasmscan.js'));

const [file, spec] = process.argv.slice(2);
const m = S.load(file);
const fi = S.resolve(m, spec);
if (fi < 0) { console.error('not found ' + spec); process.exit(2); }
const r = S.bodyRange(m, fi);
const ins = [...S.walk(m.buf, r.code, r.end)];

const chains = [];
let i = 0;
while (i < ins.length) {
  // try to start a chain at i
  let j = i, local = null, len = 0, keys = [];
  while (j + 3 < ins.length) {
    const a = ins[j], b = ins[j + 1], c = ins[j + 2], d = ins[j + 3];
    if (a.name !== 'local.get') break;
    if (b.name !== 'i32.const') break;
    if (c.name !== 'i32.eq' && c.name !== 'i32.ne') break;
    if (d.name !== 'br_if' && d.name !== 'if') break;
    if (local === null) local = a.imm; else if (a.imm !== local) break;
    keys.push(b.imm);
    len++;
    j += 4;
    // an `if` opens a block; a chain built of if/else nests, so allow the
    // body to follow — we only count contiguous compare-then-branch runs.
    if (d.name === 'if') break;
  }
  if (len >= 3) { chains.push({ at: i, off: ins[i].off - r.code, local, len, keys }); i = j; }
  else i++;
}
chains.sort((a, b) => b.len - a.len);
let tot = 0; for (const c of chains) tot += c.len;
console.log(`# ${m.names.get(fi) || '#' + fi}: ${ins.length} instrs, ${chains.length} chains (len>=3), ${tot} compares in chains`);
for (const c of chains.slice(0, 15)) {
  console.log(`  chain len=${c.len} local=${c.local} @instr ${c.at} byte ${c.off}  keys[0..12]=${c.keys.slice(0, 13).join(',')}`);
}
const hist = new Map();
for (const c of chains) { const b = c.len >= 100 ? '100+' : c.len >= 30 ? '30-99' : c.len >= 10 ? '10-29' : '3-9'; hist.set(b, (hist.get(b) || 0) + 1); }
console.log('  length buckets: ' + [...hist].map(([k, v]) => `${k}:${v}`).join(' '));
