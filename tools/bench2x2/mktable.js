#!/usr/bin/env node
// bench-2x2: render the report tables straight from results/*.txt.
//
// Every number in the writeup comes from here rather than from a human reading
// a terminal and retyping — a transcription slip is indistinguishable from a
// fabricated measurement once it is in a markdown table.
//
//   node mktable.js <results-dir>
'use strict';
const fs = require('fs');
const path = require('path');

const dir = process.argv[2] || path.join(process.env.HOME, 'build/bench2x2/results');

const CELLS = ['cpython-ours', 'cpython-clang', 'micropython-256k', 'micropython-32m'];
const LABEL = {
  'cpython-ours': 'CPython x ours',
  'cpython-clang': 'CPython x clang',
  'micropython-256k': 'MicroPython x ours (256 KB heap)',
  'micropython-32m': 'MicroPython x ours (32 MB heap)',
};

function read(name) {
  const p = path.join(dir, name + '.txt');
  if (!fs.existsSync(p)) return null;
  const xs = fs.readFileSync(p, 'utf8').split('\n')
    .map(s => s.trim()).filter(s => /^\d+$/.test(s)).map(Number);
  return xs.length ? xs : null;          // empty file => null => "NOT RUN"
}

const pct = (s, p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
function st(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  return { n: s.length, min: s[0], p50: pct(s, 50), p90: pct(s, 90), p99: pct(s, 99), max: s[s.length - 1] };
}
function ms(v) { return (v / 1e6).toFixed(v / 1e6 >= 100 ? 0 : 2) + ' ms'; }
function us(v) { return (v / 1e3).toFixed(1) + ' us'; }
function ns(v) { return v >= 1e6 ? ms(v) : v >= 1e3 ? us(v) : v.toFixed(1) + ' ns'; }

let out = '';
const P = s => { out += s + '\n'; };

// ------------------------------------------------------------------ startup ---
P('### 1. STARTUP  — whole process, Node host, `-c pass`');
P('');
P('| cell | n | p50 | min..max |');
P('|---|---|---|---|');
for (const c of CELLS) {
  const xs = read('startup-' + c);
  if (!xs) { P(`| ${LABEL[c]} | — | **NOT RUN** | — |`); continue; }
  const s = st(xs);
  P(`| ${LABEL[c]} | ${s.n} | **${ms(s.p50)}** | ${ms(s.min)} .. ${ms(s.max)} |`);
}

// --------------------------------------------------------------- throughput ---
P('');
P('### 2. THROUGHPUT — steady state, ns per loop iteration (SCALE=20000, n=5)');
P('');
P('| cell | arith | alloc | call |');
P('|---|---|---|---|');
for (const c of CELLS) {
  const row = ['arith', 'alloc', 'call'].map(k => {
    const xs = read('thru-' + k + '-' + c);
    return xs ? ns(st(xs).p50 / 20000) : '**NOT RUN**';
  });
  P(`| ${LABEL[c]} | ${row[0]} | ${row[1]} | ${row[2]} |`);
}

// ----------------------------------------------------------------------- GC ---
// A DISTRIBUTION, never a mean: max and p99 are the whole point of a GC number.
for (const mode of ['auto', 'nogc', 'control']) {
  const title = {
    auto: '3a. GC — collector in default automatic mode (600 frames)',
    nogc: '3b. GC — cyclic collector DISABLED (CPython: refcounting only)',
    control: '3c. POSITIVE CONTROL — deliberate pause injected at frame 300',
  }[mode];
  P('');
  P('### ' + title);
  P('');
  P('| cell | n | p50 | p90 | p99 | max |');
  P('|---|---|---|---|---|---|');
  for (const c of CELLS) {
    const xs = read('frames-' + mode + '-' + c) || read(mode + '-' + c);
    if (!xs) { P(`| ${LABEL[c]} | — | **NOT RUN** | — | — | — |`); continue; }
    const s = st(xs);
    P(`| ${LABEL[c]} | ${s.n} | ${ns(s.p50)} | ${ns(s.p90)} | **${ns(s.p99)}** | **${ns(s.max)}** |`);
  }
}

process.stdout.write(out);
