#!/usr/bin/env node
// wasmscan.js — a minimal, dependency-free wasm reader for todos/0332.
//
// There is no wabt on this machine (wasm2wat/wasm-objdump/wasm-dis are all
// absent and package managers are forbidden), so this is the disassembly
// substrate the 0332 investigation runs on. It decodes just enough to answer
// "how is this function's control flow lowered": the section table, the name
// section, and a full opcode walk of a function body.
//
//   node wasmscan.js <file.wasm> --list [substr]      function name -> size
//   node wasmscan.js <file.wasm> --hist <name|#idx>   opcode histogram
//   node wasmscan.js <file.wasm> --dump <name|#idx>   linear disassembly
//   node wasmscan.js <file.wasm> --brtables <name|#idx>  br_table shapes
'use strict';
const fs = require('fs');

function u32(b, p) { let r = 0, s = 0, x; do { x = b[p.i++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80); return r >>> 0; }
function i32(b, p) { let r = 0, s = 0, x; do { x = b[p.i++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80); if (s < 32 && (x & 0x40)) r |= (~0 << s); return r; }
function i64(b, p) { let r = 0n, s = 0n, x; do { x = b[p.i++]; r |= BigInt(x & 0x7f) << s; s += 7n; } while (x & 0x80); if (s < 64n && (x & 0x40)) r -= (1n << s); return r; }

function sections(buf) {
  const p = { i: 8 };
  const out = [];
  while (p.i < buf.length) {
    const id = buf[p.i++];
    const size = u32(buf, p);
    out.push({ id, start: p.i, size });
    p.i += size;
  }
  return out;
}

// ── the module model we need: imported function count, code bodies, names ──
function parse(buf) {
  const secs = sections(buf);
  let importedFuncs = 0, funcTypes = [], code = [], names = new Map(), types = [];
  for (const s of secs) {
    const p = { i: s.start };
    if (s.id === 1) { // type
      const n = u32(buf, p);
      for (let k = 0; k < n; k++) {
        p.i++; // 0x60
        const np = u32(buf, p); const params = [];
        for (let j = 0; j < np; j++) params.push(buf[p.i++]);
        const nr = u32(buf, p); const results = [];
        for (let j = 0; j < nr; j++) results.push(buf[p.i++]);
        types.push({ params, results });
      }
    } else if (s.id === 2) { // import
      const n = u32(buf, p);
      for (let k = 0; k < n; k++) {
        const ml = u32(buf, p); p.i += ml;
        const nl = u32(buf, p); p.i += nl;
        const kind = buf[p.i++];
        if (kind === 0) { u32(buf, p); importedFuncs++; }
        else if (kind === 1) { p.i++; const fl = buf[p.i++]; u32(buf, p); if (fl) u32(buf, p); }
        else if (kind === 2) { const fl = buf[p.i++]; u32(buf, p); if (fl) u32(buf, p); }
        else if (kind === 3) { p.i++; p.i++; }
      }
    } else if (s.id === 3) { // function
      const n = u32(buf, p);
      for (let k = 0; k < n; k++) funcTypes.push(u32(buf, p));
    } else if (s.id === 10) { // code
      const n = u32(buf, p);
      for (let k = 0; k < n; k++) {
        const sz = u32(buf, p);
        code.push({ start: p.i, size: sz });
        p.i += sz;
      }
    } else if (s.id === 0) { // custom
      const nl = u32(buf, p);
      const nm = buf.toString('utf8', p.i, p.i + nl); p.i += nl;
      if (nm === 'name') {
        const end = s.start + s.size;
        while (p.i < end) {
          const sub = buf[p.i++]; const ssz = u32(buf, p); const send = p.i + ssz;
          if (sub === 1) {
            const cnt = u32(buf, p);
            for (let k = 0; k < cnt; k++) {
              const idx = u32(buf, p); const l = u32(buf, p);
              names.set(idx, buf.toString('utf8', p.i, p.i + l)); p.i += l;
            }
          }
          p.i = send;
        }
      }
    }
  }
  return { buf, secs, importedFuncs, funcTypes, code, names, types };
}

// ── opcode table: name + immediate decoder ──
const IMM = {
  // control
  0x02: 'blocktype', 0x03: 'blocktype', 0x04: 'blocktype', 0x05: '', 0x0b: '', 0x0c: 'u32',
  0x0d: 'u32', 0x0e: 'brtable', 0x0f: '', 0x10: 'u32', 0x11: 'callind', 0x00: '', 0x01: '',
  0x1a: '', 0x1b: '', 0x1c: 'selectt',
  0x20: 'u32', 0x21: 'u32', 0x22: 'u32', 0x23: 'u32', 0x24: 'u32', 0x25: 'u32', 0x26: 'u32',
  0x41: 'i32', 0x42: 'i64', 0x43: 'f32', 0x44: 'f64',
  0x3f: 'u32', 0x40: 'u32',
  0xfc: 'misc',
};
for (let op = 0x28; op <= 0x3e; op++) IMM[op] = 'memarg';
const NAMES = {
  0x00: 'unreachable', 0x01: 'nop', 0x02: 'block', 0x03: 'loop', 0x04: 'if', 0x05: 'else',
  0x0b: 'end', 0x0c: 'br', 0x0d: 'br_if', 0x0e: 'br_table', 0x0f: 'return', 0x10: 'call',
  0x11: 'call_indirect', 0x1a: 'drop', 0x1b: 'select', 0x1c: 'select_t',
  0x20: 'local.get', 0x21: 'local.set', 0x22: 'local.tee', 0x23: 'global.get', 0x24: 'global.set',
  0x28: 'i32.load', 0x29: 'i64.load', 0x2a: 'f32.load', 0x2b: 'f64.load',
  0x2c: 'i32.load8_s', 0x2d: 'i32.load8_u', 0x2e: 'i32.load16_s', 0x2f: 'i32.load16_u',
  0x30: 'i64.load8_s', 0x31: 'i64.load8_u', 0x32: 'i64.load16_s', 0x33: 'i64.load16_u',
  0x34: 'i64.load32_s', 0x35: 'i64.load32_u',
  0x36: 'i32.store', 0x37: 'i64.store', 0x38: 'f32.store', 0x39: 'f64.store',
  0x3a: 'i32.store8', 0x3b: 'i32.store16', 0x3c: 'i64.store8', 0x3d: 'i64.store16', 0x3e: 'i64.store32',
  0x3f: 'memory.size', 0x40: 'memory.grow',
  0x41: 'i32.const', 0x42: 'i64.const', 0x43: 'f32.const', 0x44: 'f64.const',
  0x45: 'i32.eqz', 0x46: 'i32.eq', 0x47: 'i32.ne', 0x48: 'i32.lt_s', 0x49: 'i32.lt_u',
  0x4a: 'i32.gt_s', 0x4b: 'i32.gt_u', 0x4c: 'i32.le_s', 0x4d: 'i32.le_u', 0x4e: 'i32.ge_s', 0x4f: 'i32.ge_u',
  0x50: 'i64.eqz', 0x51: 'i64.eq', 0x52: 'i64.ne', 0x53: 'i64.lt_s', 0x54: 'i64.lt_u',
  0x55: 'i64.gt_s', 0x56: 'i64.gt_u', 0x57: 'i64.le_s', 0x58: 'i64.le_u', 0x59: 'i64.ge_s', 0x5a: 'i64.ge_u',
  0x6a: 'i32.add', 0x6b: 'i32.sub', 0x6c: 'i32.mul', 0x6d: 'i32.div_s', 0x6e: 'i32.div_u',
  0x6f: 'i32.rem_s', 0x70: 'i32.rem_u', 0x71: 'i32.and', 0x72: 'i32.or', 0x73: 'i32.xor',
  0x74: 'i32.shl', 0x75: 'i32.shr_s', 0x76: 'i32.shr_u', 0x77: 'i32.rotl', 0x78: 'i32.rotr',
  0x7c: 'i64.add', 0x7d: 'i64.sub', 0x7e: 'i64.mul',
};

function* walk(buf, start, end) {
  const p = { i: start };
  while (p.i < end) {
    const off = p.i;
    const op = buf[p.i++];
    let imm = null;
    const kind = IMM[op];
    if (kind === 'blocktype') { const b = buf[p.i]; if (b === 0x40 || (b >= 0x7b && b <= 0x7f)) p.i++; else imm = i32(buf, p); }
    else if (kind === 'u32') imm = u32(buf, p);
    else if (kind === 'i32') imm = i32(buf, p);
    else if (kind === 'i64') imm = i64(buf, p);
    else if (kind === 'f32') p.i += 4;
    else if (kind === 'f64') p.i += 8;
    else if (kind === 'memarg') { u32(buf, p); imm = u32(buf, p); }
    else if (kind === 'callind') { u32(buf, p); u32(buf, p); }
    else if (kind === 'selectt') { const n = u32(buf, p); p.i += n; }
    else if (kind === 'misc') { const s = u32(buf, p); if (s === 8) { u32(buf, p); p.i++; } else if (s === 9 || s === 13) u32(buf, p); else if (s === 10) { p.i += 2; } else if (s === 11) p.i++; }
    else if (kind === 'brtable') {
      const n = u32(buf, p); const tgts = [];
      for (let k = 0; k < n; k++) tgts.push(u32(buf, p));
      tgts.push(u32(buf, p)); // default
      imm = tgts;
    }
    yield { off, op, imm, name: NAMES[op] || ('op0x' + op.toString(16)) };
  }
}

function bodyRange(m, fi) {
  const c = m.code[fi - m.importedFuncs];
  if (!c) return null;
  // skip locals decl
  const p = { i: c.start };
  const n = u32(m.buf, p);
  for (let k = 0; k < n; k++) { u32(m.buf, p); p.i++; }
  return { code: p.i, end: c.start + c.size, declStart: c.start };
}

function resolve(m, spec) {
  if (spec.startsWith('#')) return parseInt(spec.slice(1), 10);
  // `@big` = the largest defined function. compiler.js emits no name section,
  // so this is how a diagnostic addresses "the eval loop" in OUR artifacts:
  // in both CPython builds the largest function IS _PyEval_EvalFrameDefault
  // (verified against the clang build's name section, where it is #4594).
  if (spec === '@big') {
    let best = -1, bestSz = -1;
    for (let k = 0; k < m.code.length; k++) if (m.code[k].size > bestSz) { bestSz = m.code[k].size; best = k + m.importedFuncs; }
    return best;
  }
  for (const [i, n] of m.names) if (n === spec) return i;
  for (const [i, n] of m.names) if (n.includes(spec)) return i;
  return -1;
}

function main() {
  const [file, mode, arg] = process.argv.slice(2);
  const buf = fs.readFileSync(file);
  const m = parse(buf);
  if (mode === '--sections') {
    for (const s of m.secs) console.log(`sec ${s.id} size ${s.size}`);
    console.log(`imported funcs ${m.importedFuncs}, defined ${m.code.length}, names ${m.names.size}`);
    return;
  }
  if (mode === '--list') {
    const rows = [];
    for (let k = 0; k < m.code.length; k++) {
      const fi = k + m.importedFuncs;
      const nm = m.names.get(fi) || `func${fi}`;
      if (arg && !nm.includes(arg)) continue;
      rows.push({ fi, nm, size: m.code[k].size });
    }
    rows.sort((a, b) => b.size - a.size);
    for (const r of rows.slice(0, 60)) console.log(`${String(r.size).padStart(9)}  #${r.fi}  ${r.nm}`);
    console.log(`(${rows.length} matched, ${m.code.length} defined funcs)`);
    return;
  }
  const fi = resolve(m, arg);
  if (fi < 0) { console.error('not found: ' + arg); process.exit(2); }
  const r = bodyRange(m, fi);
  const nm = m.names.get(fi) || `func${fi}`;
  if (mode === '--hist') {
    const h = new Map();
    let n = 0;
    for (const ins of walk(buf, r.code, r.end)) { h.set(ins.name, (h.get(ins.name) || 0) + 1); n++; }
    const rows = [...h].sort((a, b) => b[1] - a[1]);
    console.log(`# ${nm} (#${fi}) body ${r.end - r.code} bytes, ${n} instructions`);
    for (const [k, v] of rows) console.log(`${String(v).padStart(8)}  ${k}`);
    return;
  }
  if (mode === '--brtables') {
    let i = 0;
    for (const ins of walk(buf, r.code, r.end)) {
      if (ins.op === 0x0e) console.log(`br_table#${i++} @${ins.off - r.code} entries=${ins.imm.length - 1} default=${ins.imm[ins.imm.length - 1]} distinct=${new Set(ins.imm).size}`);
    }
    console.log(`# ${nm}: ${i} br_table(s)`);
    return;
  }
  if (mode === '--dump') {
    const from = process.argv[5] ? parseInt(process.argv[5], 10) : 0;
    const count = process.argv[6] ? parseInt(process.argv[6], 10) : 400;
    let k = 0, depth = 0;
    for (const ins of walk(buf, r.code, r.end)) {
      if (ins.op === 0x0b || ins.op === 0x05) depth--;
      if (k >= from && k < from + count) {
        let extra = ins.imm === null ? '' : (Array.isArray(ins.imm) ? ` [${ins.imm.length - 1} entries, default ${ins.imm[ins.imm.length - 1]}] ${ins.imm.slice(0, 24).join(',')}` : ' ' + ins.imm);
        if (ins.op === 0x10) extra += ` <${m.names.get(ins.imm) || ''}>`;
        console.log(`${String(k).padStart(7)} @${String(ins.off - r.code).padStart(7)} ${'  '.repeat(Math.max(0, Math.min(depth, 12)))}${ins.name}${extra}`);
      }
      if (ins.op === 0x02 || ins.op === 0x03 || ins.op === 0x04 || ins.op === 0x05) depth++;
      k++;
      if (k >= from + count) break;
    }
    return;
  }
  console.error('modes: --sections --list --hist --dump --brtables');
  process.exit(2);
}

module.exports = { parse, walk, bodyRange, resolve, load: (f) => parse(fs.readFileSync(f)) };
if (require.main === module) main();
