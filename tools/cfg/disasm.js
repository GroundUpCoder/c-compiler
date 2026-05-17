"use strict";

// disasm.js — minimal-but-useful wasm disassembler.
//
// Parses the binary format for the sections cfg.js actually emits:
//   1: type           — full struct/array/func with rec groups + sub markers
//   2: import         — function + global imports
//   3: function       — typeidx for each defined function
//   7: export         — name + kind + idx
//   10: code          — local declarations + raw body bytes
//
// Anything else (table, memory, global, start, element, data, custom) is
// captured as `{ id, raw: Uint8Array }` so the caller can inspect bytes
// without us having to handle every section. Instruction-level disasm
// inside function bodies is out of scope — body bytes are surfaced
// verbatim. That's sufficient for "is this typeidx referenced?" style
// tests; for opcode-by-opcode verification, scan the bytes manually.
//
// Output shape:
//   {
//     magic: 'wasm',
//     version: 1,
//     sections: [{ id, name, ... }, ...],   // in order
//     types:    [DisasmType, ...],          // flat, indexed by typeidx
//     imports:  [DisasmImport, ...],
//     funcs:    [{ typeidx, localGroups, body }, ...],   // defined funcs
//     exports:  [{ name, kind, idx }, ...],
//   }
//
// DisasmType kinds:
//   { kind:'struct', supers, final, fields: [{type, mut}] }
//   { kind:'array',  supers, final, element, mut }
//   { kind:'func',   params: [...], results: [...] }
//
// DisasmValueType kinds:
//   { kind:'i32' | 'i64' | 'f32' | 'f64' }
//   { kind:'ref', nullable, heap }
//
// DisasmHeapType kinds:
//   { kind:'idx', idx }
//   { kind:'abstract', name }   // 'extern', 'any', 'eq', 'i31', 'func', ...

const SECTION_NAMES = {
  0: 'custom', 1: 'type', 2: 'import', 3: 'function', 4: 'table',
  5: 'memory', 6: 'global', 7: 'export', 8: 'start', 9: 'element',
  10: 'code', 11: 'data', 12: 'datacount',
};

// Abstract heap-type sleb codes.
const ABSTRACT_HEAP_TYPES = {
  [-0x10]: 'func',     // -16
  [-0x11]: 'extern',   // -17
  [-0x12]: 'any',      // -18
  [-0x13]: 'eq',       // -19
  [-0x14]: 'i31',      // -20
  [-0x15]: 'nofunc',   // -21
  [-0x16]: 'noextern', // -22
  [-0x17]: 'none',     // -23
  [-0x18]: 'struct',   // -24
  [-0x19]: 'array',    // -25
};

// ─────────────────────────── Reader ───────────────────────────

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }
  eof() { return this.pos >= this.bytes.length; }
  remaining() { return this.bytes.length - this.pos; }
  byte() { return this.bytes[this.pos++]; }
  bytes_(n) {
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  uleb() {
    let result = 0, shift = 0;
    while (true) {
      const b = this.byte();
      result |= (b & 0x7F) << shift;
      if ((b & 0x80) === 0) return result >>> 0;
      shift += 7;
      if (shift > 35) throw new Error('uleb128: too long');
    }
  }
  sleb() {
    let result = 0, shift = 0, b;
    do {
      b = this.byte();
      result |= (b & 0x7F) << shift;
      shift += 7;
    } while (b & 0x80);
    if (shift < 32 && (b & 0x40)) result |= (~0 << shift);
    return result | 0;
  }
  // Length-prefixed UTF-8 string (wasm "name").
  name() {
    const n = this.uleb();
    const buf = this.bytes_(n);
    return new TextDecoder('utf-8').decode(buf);
  }
}

// ─────────────────────────── Type parsing ───────────────────────────

function parseHeapType(r) {
  // Heap types are sleb128. Negative = abstract; non-negative = typeidx.
  // Save pos in case it's a positive typeidx; we sleb-decode to allow
  // negative codes, then determine which kind by sign.
  const code = r.sleb();
  if (code < 0) {
    const name = ABSTRACT_HEAP_TYPES[code];
    if (!name) throw new Error(`Unknown abstract heap type code ${code}`);
    return { kind: 'abstract', name };
  }
  return { kind: 'idx', idx: code };
}

function parseValueType(r) {
  // Peek the first byte; some are single-byte, some are prefix codes.
  const first = r.bytes[r.pos];
  switch (first) {
    case 0x7F: r.pos++; return { kind: 'i32' };
    case 0x7E: r.pos++; return { kind: 'i64' };
    case 0x7D: r.pos++; return { kind: 'f32' };
    case 0x7C: r.pos++; return { kind: 'f64' };
    case 0x6F: r.pos++; return { kind: 'ref', nullable: true,  heap: { kind: 'abstract', name: 'extern' } };
    case 0x70: r.pos++; return { kind: 'ref', nullable: true,  heap: { kind: 'abstract', name: 'func' } };
    case 0x6E: r.pos++; return { kind: 'ref', nullable: true,  heap: { kind: 'abstract', name: 'any' } };
    case 0x6D: r.pos++; return { kind: 'ref', nullable: true,  heap: { kind: 'abstract', name: 'eq' } };
    case 0x6C: r.pos++; return { kind: 'ref', nullable: true,  heap: { kind: 'abstract', name: 'i31' } };
    case 0x6B: r.pos++; return { kind: 'ref', nullable: true,  heap: { kind: 'abstract', name: 'struct' } };
    case 0x6A: r.pos++; return { kind: 'ref', nullable: true,  heap: { kind: 'abstract', name: 'array' } };
    case 0x64: r.pos++; return { kind: 'ref', nullable: false, heap: parseHeapType(r) };
    case 0x63: r.pos++; return { kind: 'ref', nullable: true,  heap: parseHeapType(r) };
    default:
      throw new Error(`Unknown value type byte 0x${first.toString(16)} at pos ${r.pos}`);
  }
}

// Block type for `block`/`loop`/`if`. Either 0x40 (void), a value type,
// or an sleb-encoded typeidx (for multi-result blocks).
function parseBlockType(r) {
  const peek = r.bytes[r.pos];
  if (peek === 0x40) { r.pos++; return { kind: 'void' }; }
  // Try value-type byte set first (single-byte primitives + ref shorthands).
  const isValueTypeByte = (peek === 0x7F || peek === 0x7E || peek === 0x7D || peek === 0x7C
                       || peek === 0x6F || peek === 0x70 || peek === 0x6E || peek === 0x6D
                       || peek === 0x6C || peek === 0x6B || peek === 0x6A
                       || peek === 0x64 || peek === 0x63);
  if (isValueTypeByte) return { kind: 'value', type: parseValueType(r) };
  // Otherwise: sleb typeidx.
  const idx = r.sleb();
  return { kind: 'typeidx', idx };
}

// Storage type: value types + the two packed types (i8 = 0x78, i16 = 0x77),
// used in struct field and array element type positions only.
function parseStorageType(r) {
  const first = r.bytes[r.pos];
  if (first === 0x78) { r.pos++; return { kind: 'i8' }; }
  if (first === 0x77) { r.pos++; return { kind: 'i16' }; }
  return parseValueType(r);
}

function parseFieldType(r) {
  const type = parseStorageType(r);
  const mut = r.byte() === 0x01;
  return { type, mut };
}

function parseCompType(r) {
  const tag = r.byte();
  if (tag === 0x60) {
    const np = r.uleb();
    const params = [];
    for (let i = 0; i < np; i++) params.push(parseValueType(r));
    const nr = r.uleb();
    const results = [];
    for (let i = 0; i < nr; i++) results.push(parseValueType(r));
    return { kind: 'func', params, results };
  }
  if (tag === 0x5F) {
    const nf = r.uleb();
    const fields = [];
    for (let i = 0; i < nf; i++) fields.push(parseFieldType(r));
    return { kind: 'struct', fields };
  }
  if (tag === 0x5E) {
    return { kind: 'array', element: parseStorageType(r), mut: r.byte() === 0x01 };
  }
  throw new Error(`Unknown comptype tag 0x${tag.toString(16)}`);
}

function parseSubType(r) {
  // 0x50: sub  (open) — count + supertype-typeidx*
  // 0x4F: sub final     — count + supertype-typeidx*
  // else: bare comptype (final, no supers)
  const peek = r.bytes[r.pos];
  if (peek === 0x50 || peek === 0x4F) {
    const final = (peek === 0x4F);
    r.pos++;
    const ns = r.uleb();
    const supers = [];
    for (let i = 0; i < ns; i++) supers.push(r.uleb());
    const comp = parseCompType(r);
    return { ...comp, supers, final };
  }
  const comp = parseCompType(r);
  return { ...comp, supers: [], final: true };
}

function parseTypeSection(r) {
  const types = [];
  const n = r.uleb();
  for (let i = 0; i < n; i++) {
    const peek = r.bytes[r.pos];
    if (peek === 0x4E) {
      // rec group
      r.pos++;
      const m = r.uleb();
      for (let j = 0; j < m; j++) types.push(parseSubType(r));
    } else {
      types.push(parseSubType(r));
    }
  }
  return types;
}

// ─────────────────────────── Imports + Exports ───────────────────────────

function parseGlobalType(r) {
  const valueType = parseValueType(r);
  const mut = r.byte() === 0x01;
  return { valueType, mut };
}

function parseLimits(r) {
  const flags = r.byte();
  const min = r.uleb();
  const max = (flags & 0x01) ? r.uleb() : null;
  return { min, max };
}

function parseImportSection(r) {
  const out = [];
  const n = r.uleb();
  for (let i = 0; i < n; i++) {
    const module_ = r.name();
    const name = r.name();
    const kind = r.byte();
    if (kind === 0x00) {
      out.push({ module: module_, name, kind: 'func', typeidx: r.uleb() });
    } else if (kind === 0x01) {
      // table: limits + reftype (we don't model fully)
      // Note: skipping for v0 — emit raw if encountered
      throw new Error('Table imports not yet handled');
    } else if (kind === 0x02) {
      out.push({ module: module_, name, kind: 'memory', limits: parseLimits(r) });
    } else if (kind === 0x03) {
      out.push({ module: module_, name, kind: 'global', ...parseGlobalType(r) });
    } else {
      throw new Error(`Unknown import kind ${kind}`);
    }
  }
  return out;
}

function parseFunctionSection(r) {
  const out = [];
  const n = r.uleb();
  for (let i = 0; i < n; i++) out.push(r.uleb());
  return out;
}

function parseExportSection(r) {
  const out = [];
  const n = r.uleb();
  for (let i = 0; i < n; i++) {
    const name = r.name();
    const kind = r.byte();
    const idx = r.uleb();
    const kindName = ['func', 'table', 'memory', 'global', 'tag'][kind] || `kind${kind}`;
    out.push({ name, kind: kindName, idx });
  }
  return out;
}

function parseCodeSection(r) {
  const out = [];
  const n = r.uleb();
  for (let i = 0; i < n; i++) {
    const bodyLen = r.uleb();
    const bodyStart = r.pos;
    const groupsCount = r.uleb();
    const localGroups = [];
    for (let g = 0; g < groupsCount; g++) {
      const count = r.uleb();
      const type = parseValueType(r);
      localGroups.push({ count, type });
    }
    const bodyBytesStart = r.pos;
    const bodyBytesLen = bodyLen - (r.pos - bodyStart);
    const body = r.bytes_(bodyBytesLen);
    out.push({ localGroups, body });
  }
  return out;
}

// Custom "name" section: subsection 1 (function names) + subsection 4
// (type names). Returns { funcNames: Map<idx,name>, typeNames: Map<idx,name> }.
function parseNameSection(r) {
  const out = { funcNames: new Map(), typeNames: new Map(), moduleName: null };
  while (!r.eof()) {
    const sub = r.byte();
    const subSize = r.uleb();
    const subEnd = r.pos + subSize;
    if (sub === 0) {
      out.moduleName = r.name();
    } else if (sub === 1) {
      const n = r.uleb();
      for (let i = 0; i < n; i++) {
        const idx = r.uleb();
        const name = r.name();
        out.funcNames.set(idx, name);
      }
    } else if (sub === 4) {
      const n = r.uleb();
      for (let i = 0; i < n; i++) {
        const idx = r.uleb();
        const name = r.name();
        out.typeNames.set(idx, name);
      }
    }
    r.pos = subEnd;
  }
  return out;
}

// ─────────────────────────── Top-level disassemble ───────────────────────────

function disassemble(bytes) {
  if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  const r = new Reader(bytes);

  // Header.
  if (r.byte() !== 0x00 || r.byte() !== 0x61
      || r.byte() !== 0x73 || r.byte() !== 0x6D) {
    throw new Error('Not a wasm module: missing magic 0asm');
  }
  const version = r.byte() | (r.byte() << 8) | (r.byte() << 16) | (r.byte() << 24);

  const result = {
    magic: 'wasm', version,
    sections: [],
    types: [],
    imports: [],
    funcs: [],     // defined functions: { typeidx, localGroups, body }
    exports: [],
  };

  // The "function" section gives typeidxes; "code" section gives bodies.
  // Both are per-defined-function in matching order. Stash typeidxes
  // until we see code, then zip them.
  let pendingFuncTypeIdxes = null;

  while (!r.eof()) {
    const id = r.byte();
    const size = r.uleb();
    const sectionStart = r.pos;
    const sectionEnd = sectionStart + size;
    const sub = new Reader(bytes.subarray(sectionStart, sectionEnd));
    let parsed;
    switch (id) {
      case 0: {
        // Custom section: name-prefixed payload.
        const customName = sub.name();
        if (customName === 'name') {
          parsed = parseNameSection(sub);
          result.names = parsed;
        } else {
          parsed = { id, customName, raw: bytes.subarray(sectionStart + sub.pos, sectionEnd) };
        }
        break;
      }
      case 1:
        parsed = parseTypeSection(sub);
        result.types = parsed;
        break;
      case 2:
        parsed = parseImportSection(sub);
        result.imports = parsed;
        break;
      case 3:
        parsed = parseFunctionSection(sub);
        pendingFuncTypeIdxes = parsed;
        break;
      case 7:
        parsed = parseExportSection(sub);
        result.exports = parsed;
        break;
      case 10:
        parsed = parseCodeSection(sub);
        if (pendingFuncTypeIdxes && pendingFuncTypeIdxes.length === parsed.length) {
          result.funcs = parsed.map((f, i) => ({
            typeidx: pendingFuncTypeIdxes[i],
            localGroups: f.localGroups,
            body: f.body,
          }));
        } else {
          result.funcs = parsed;
        }
        break;
      default:
        parsed = { id, name: SECTION_NAMES[id] || `section${id}`, raw: bytes.subarray(sectionStart, sectionEnd) };
        break;
    }
    result.sections.push({
      id,
      name: SECTION_NAMES[id] || `section${id}`,
      parsed,
      length: sectionEnd - sectionStart,
    });
    r.pos = sectionEnd;
  }

  // Attach names to funcs/imports/types if a name section was present.
  if (result.names) {
    const importedFuncCount = result.imports.filter(i => i.kind === 'func').length;
    let funcIdx = 0;
    for (const im of result.imports) {
      if (im.kind === 'func') {
        const name = result.names.funcNames.get(funcIdx);
        if (name !== undefined) im.debugName = name;
        funcIdx++;
      }
    }
    result.funcs.forEach((f, i) => {
      const name = result.names.funcNames.get(importedFuncCount + i);
      if (name !== undefined) f.name = name;
    });
    result.types.forEach((t, i) => {
      const name = result.names.typeNames.get(i);
      if (name !== undefined) t.name = name;
    });
  }
  return result;
}

// ─────────────────────────── Instruction walker ───────────────────────────
//
// Table-driven walker covering the full MVP wasm spec plus reference
// types, GC, sign-extension, saturating-truncation, bulk memory.
// SIMD (0xFD) and atomics (0xFE) are not parsed — opcodes in those
// prefixes throw. Every other opcode that appears in a valid wasm
// module should walk cleanly.
//
// Each emitted record is `{ op, ...immediates }`. Immediate fields:
//   - target / default / targets: br / br_if / br_table label indices
//   - idx: local/global index
//   - funcidx, tableidx, typeidx, fieldidx, dataidx, elemidx: as named
//   - value: literal value for i32.const / i64.const
//   - bytes: raw 4 (f32) or 8 (f64) bytes for float consts
//   - heap: parsed heap type for ref.null / ref.test / ref.cast / select-typed
//   - align, offset: memory access immediates
//   - memidx: memory index (for multi-memory; usually 0)

// Single-byte ops with NO immediate. Includes all numeric arithmetic /
// comparison / conversion ops (0x45..0xC4) plus simple control + ref ops.
const _OP_NAMES = (() => {
  const t = {};
  // control
  t[0x00] = 'unreachable';   t[0x01] = 'nop';
  t[0x05] = 'else';          t[0x0B] = 'end';
  t[0x0F] = 'return';
  // parametric
  t[0x1A] = 'drop';          t[0x1B] = 'select';
  // numeric — comparisons
  t[0x45] = 'i32.eqz';   t[0x46] = 'i32.eq';    t[0x47] = 'i32.ne';
  t[0x48] = 'i32.lt_s';  t[0x49] = 'i32.lt_u';  t[0x4A] = 'i32.gt_s';  t[0x4B] = 'i32.gt_u';
  t[0x4C] = 'i32.le_s';  t[0x4D] = 'i32.le_u';  t[0x4E] = 'i32.ge_s';  t[0x4F] = 'i32.ge_u';
  t[0x50] = 'i64.eqz';   t[0x51] = 'i64.eq';    t[0x52] = 'i64.ne';
  t[0x53] = 'i64.lt_s';  t[0x54] = 'i64.lt_u';  t[0x55] = 'i64.gt_s';  t[0x56] = 'i64.gt_u';
  t[0x57] = 'i64.le_s';  t[0x58] = 'i64.le_u';  t[0x59] = 'i64.ge_s';  t[0x5A] = 'i64.ge_u';
  t[0x5B] = 'f32.eq';    t[0x5C] = 'f32.ne';    t[0x5D] = 'f32.lt';    t[0x5E] = 'f32.gt';
  t[0x5F] = 'f32.le';    t[0x60] = 'f32.ge';
  t[0x61] = 'f64.eq';    t[0x62] = 'f64.ne';    t[0x63] = 'f64.lt';    t[0x64] = 'f64.gt';
  t[0x65] = 'f64.le';    t[0x66] = 'f64.ge';
  // numeric — arithmetic
  t[0x67] = 'i32.clz';   t[0x68] = 'i32.ctz';   t[0x69] = 'i32.popcnt';
  t[0x6A] = 'i32.add';   t[0x6B] = 'i32.sub';   t[0x6C] = 'i32.mul';
  t[0x6D] = 'i32.div_s'; t[0x6E] = 'i32.div_u'; t[0x6F] = 'i32.rem_s'; t[0x70] = 'i32.rem_u';
  t[0x71] = 'i32.and';   t[0x72] = 'i32.or';    t[0x73] = 'i32.xor';
  t[0x74] = 'i32.shl';   t[0x75] = 'i32.shr_s'; t[0x76] = 'i32.shr_u';
  t[0x77] = 'i32.rotl';  t[0x78] = 'i32.rotr';
  t[0x79] = 'i64.clz';   t[0x7A] = 'i64.ctz';   t[0x7B] = 'i64.popcnt';
  t[0x7C] = 'i64.add';   t[0x7D] = 'i64.sub';   t[0x7E] = 'i64.mul';
  t[0x7F] = 'i64.div_s'; t[0x80] = 'i64.div_u'; t[0x81] = 'i64.rem_s'; t[0x82] = 'i64.rem_u';
  t[0x83] = 'i64.and';   t[0x84] = 'i64.or';    t[0x85] = 'i64.xor';
  t[0x86] = 'i64.shl';   t[0x87] = 'i64.shr_s'; t[0x88] = 'i64.shr_u';
  t[0x89] = 'i64.rotl';  t[0x8A] = 'i64.rotr';
  t[0x8B] = 'f32.abs';   t[0x8C] = 'f32.neg';   t[0x8D] = 'f32.ceil';  t[0x8E] = 'f32.floor';
  t[0x8F] = 'f32.trunc'; t[0x90] = 'f32.nearest'; t[0x91] = 'f32.sqrt';
  t[0x92] = 'f32.add';   t[0x93] = 'f32.sub';   t[0x94] = 'f32.mul';   t[0x95] = 'f32.div';
  t[0x96] = 'f32.min';   t[0x97] = 'f32.max';   t[0x98] = 'f32.copysign';
  t[0x99] = 'f64.abs';   t[0x9A] = 'f64.neg';   t[0x9B] = 'f64.ceil';  t[0x9C] = 'f64.floor';
  t[0x9D] = 'f64.trunc'; t[0x9E] = 'f64.nearest'; t[0x9F] = 'f64.sqrt';
  t[0xA0] = 'f64.add';   t[0xA1] = 'f64.sub';   t[0xA2] = 'f64.mul';   t[0xA3] = 'f64.div';
  t[0xA4] = 'f64.min';   t[0xA5] = 'f64.max';   t[0xA6] = 'f64.copysign';
  // numeric — conversions
  t[0xA7] = 'i32.wrap_i64';
  t[0xA8] = 'i32.trunc_f32_s'; t[0xA9] = 'i32.trunc_f32_u';
  t[0xAA] = 'i32.trunc_f64_s'; t[0xAB] = 'i32.trunc_f64_u';
  t[0xAC] = 'i64.extend_i32_s'; t[0xAD] = 'i64.extend_i32_u';
  t[0xAE] = 'i64.trunc_f32_s'; t[0xAF] = 'i64.trunc_f32_u';
  t[0xB0] = 'i64.trunc_f64_s'; t[0xB1] = 'i64.trunc_f64_u';
  t[0xB2] = 'f32.convert_i32_s'; t[0xB3] = 'f32.convert_i32_u';
  t[0xB4] = 'f32.convert_i64_s'; t[0xB5] = 'f32.convert_i64_u';
  t[0xB6] = 'f32.demote_f64';
  t[0xB7] = 'f64.convert_i32_s'; t[0xB8] = 'f64.convert_i32_u';
  t[0xB9] = 'f64.convert_i64_s'; t[0xBA] = 'f64.convert_i64_u';
  t[0xBB] = 'f64.promote_f32';
  t[0xBC] = 'i32.reinterpret_f32'; t[0xBD] = 'i64.reinterpret_f64';
  t[0xBE] = 'f32.reinterpret_i32'; t[0xBF] = 'f64.reinterpret_i64';
  // sign-extension
  t[0xC0] = 'i32.extend8_s';  t[0xC1] = 'i32.extend16_s';
  t[0xC2] = 'i64.extend8_s';  t[0xC3] = 'i64.extend16_s'; t[0xC4] = 'i64.extend32_s';
  // reference types (single-byte forms)
  t[0xD1] = 'ref.is_null';
  t[0xD3] = 'ref.eq';
  t[0xD4] = 'ref.as_non_null';
  return t;
})();

// Memory load opcodes (single byte + memarg). Maps op → name.
const _MEM_LOAD_OPS = {
  0x28: 'i32.load',     0x29: 'i64.load',
  0x2A: 'f32.load',     0x2B: 'f64.load',
  0x2C: 'i32.load8_s',  0x2D: 'i32.load8_u',
  0x2E: 'i32.load16_s', 0x2F: 'i32.load16_u',
  0x30: 'i64.load8_s',  0x31: 'i64.load8_u',
  0x32: 'i64.load16_s', 0x33: 'i64.load16_u',
  0x34: 'i64.load32_s', 0x35: 'i64.load32_u',
};
const _MEM_STORE_OPS = {
  0x36: 'i32.store',    0x37: 'i64.store',
  0x38: 'f32.store',    0x39: 'f64.store',
  0x3A: 'i32.store8',   0x3B: 'i32.store16',
  0x3C: 'i64.store8',   0x3D: 'i64.store16', 0x3E: 'i64.store32',
};

// 0xFB-prefixed ops (GC + reference). Map sub-opcode → { name, immKind }.
// immKind: 'none' | 'typeidx' | 'typeidx+fieldidx' | 'typeidx+u32' | 'heaptype' | 'br_on_cast'
const _FB_OPS = {
  0x00: ['struct.new',          'typeidx'],
  0x01: ['struct.new_default',  'typeidx'],
  0x02: ['struct.get',          'typeidx+fieldidx'],
  0x03: ['struct.get_s',        'typeidx+fieldidx'],
  0x04: ['struct.get_u',        'typeidx+fieldidx'],
  0x05: ['struct.set',          'typeidx+fieldidx'],
  0x06: ['array.new',           'typeidx'],
  0x07: ['array.new_default',   'typeidx'],
  0x08: ['array.new_fixed',     'typeidx+u32'],
  0x09: ['array.new_data',      'typeidx+u32'],
  0x0A: ['array.new_elem',      'typeidx+u32'],
  0x0B: ['array.get',           'typeidx'],
  0x0C: ['array.get_s',         'typeidx'],
  0x0D: ['array.get_u',         'typeidx'],
  0x0E: ['array.set',           'typeidx'],
  0x0F: ['array.len',           'none'],
  0x10: ['array.fill',          'typeidx'],
  0x11: ['array.copy',          'typeidx+typeidx'],
  0x12: ['array.init_data',     'typeidx+u32'],
  0x13: ['array.init_elem',     'typeidx+u32'],
  0x14: ['ref.test',            'heaptype'],
  0x15: ['ref.test_null',       'heaptype'],
  0x16: ['ref.cast',            'heaptype'],
  0x17: ['ref.cast_null',       'heaptype'],
  0x18: ['br_on_cast',          'br_on_cast'],
  0x19: ['br_on_cast_fail',     'br_on_cast'],
  0x1A: ['any.convert_extern',  'none'],
  0x1B: ['extern.convert_any',  'none'],
  0x1C: ['ref.i31',             'none'],
  0x1D: ['i31.get_s',           'none'],
  0x1E: ['i31.get_u',           'none'],
};

// 0xFC-prefixed ops (saturating truncation + bulk memory + tables).
const _FC_OPS = {
  0:  ['i32.trunc_sat_f32_s',  'none'],
  1:  ['i32.trunc_sat_f32_u',  'none'],
  2:  ['i32.trunc_sat_f64_s',  'none'],
  3:  ['i32.trunc_sat_f64_u',  'none'],
  4:  ['i64.trunc_sat_f32_s',  'none'],
  5:  ['i64.trunc_sat_f32_u',  'none'],
  6:  ['i64.trunc_sat_f64_s',  'none'],
  7:  ['i64.trunc_sat_f64_u',  'none'],
  8:  ['memory.init',          'dataidx+memidx'],
  9:  ['data.drop',            'dataidx'],
  10: ['memory.copy',          'memidx+memidx'],
  11: ['memory.fill',          'memidx'],
  12: ['table.init',           'elemidx+tableidx'],
  13: ['elem.drop',            'elemidx'],
  14: ['table.copy',           'tableidx+tableidx'],
  15: ['table.grow',           'tableidx'],
  16: ['table.size',           'tableidx'],
  17: ['table.fill',           'tableidx'],
};

function _readMemarg(r) {
  return { align: r.uleb(), offset: r.uleb() };
}

function walkInstructions(body, onInstr) {
  const r = new Reader(body);
  while (!r.eof()) {
    const op = r.byte();

    // Single-byte, no immediate.
    if (_OP_NAMES[op] !== undefined) { onInstr({ op: _OP_NAMES[op] }); continue; }

    // Block-types (block / loop / if).
    if (op === 0x02) { const bt = parseBlockType(r); onInstr({ op: 'block', blockType: bt }); continue; }
    if (op === 0x03) { const bt = parseBlockType(r); onInstr({ op: 'loop',  blockType: bt }); continue; }
    if (op === 0x04) { const bt = parseBlockType(r); onInstr({ op: 'if',    blockType: bt }); continue; }

    // Branches.
    if (op === 0x0C) { onInstr({ op: 'br',     target: r.uleb() }); continue; }
    if (op === 0x0D) { onInstr({ op: 'br_if',  target: r.uleb() }); continue; }
    if (op === 0x0E) {
      const n = r.uleb(); const targets = [];
      for (let i = 0; i < n; i++) targets.push(r.uleb());
      const def = r.uleb();
      onInstr({ op: 'br_table', targets, default: def });
      continue;
    }

    // Calls.
    if (op === 0x10) { onInstr({ op: 'call', funcidx: r.uleb() }); continue; }
    if (op === 0x11) { onInstr({ op: 'call_indirect', typeidx: r.uleb(), tableidx: r.uleb() }); continue; }

    // Typed select (0x1C) — vec of valtypes follows.
    if (op === 0x1C) {
      const n = r.uleb(); const tys = [];
      for (let i = 0; i < n; i++) tys.push(parseValueType(r));
      onInstr({ op: 'select', resultTypes: tys });
      continue;
    }

    // Locals / globals.
    if (op === 0x20) { onInstr({ op: 'local.get',  idx: r.uleb() }); continue; }
    if (op === 0x21) { onInstr({ op: 'local.set',  idx: r.uleb() }); continue; }
    if (op === 0x22) { onInstr({ op: 'local.tee',  idx: r.uleb() }); continue; }
    if (op === 0x23) { onInstr({ op: 'global.get', idx: r.uleb() }); continue; }
    if (op === 0x24) { onInstr({ op: 'global.set', idx: r.uleb() }); continue; }

    // Tables.
    if (op === 0x25) { onInstr({ op: 'table.get', tableidx: r.uleb() }); continue; }
    if (op === 0x26) { onInstr({ op: 'table.set', tableidx: r.uleb() }); continue; }

    // Memory loads / stores.
    if (_MEM_LOAD_OPS[op] !== undefined)  { const ma = _readMemarg(r); onInstr({ op: _MEM_LOAD_OPS[op], ...ma }); continue; }
    if (_MEM_STORE_OPS[op] !== undefined) { const ma = _readMemarg(r); onInstr({ op: _MEM_STORE_OPS[op], ...ma }); continue; }

    if (op === 0x3F) { r.byte(); onInstr({ op: 'memory.size' }); continue; } // reserved 0x00
    if (op === 0x40) { r.byte(); onInstr({ op: 'memory.grow' }); continue; }

    // Const literals.
    if (op === 0x41) { onInstr({ op: 'i32.const', value: r.sleb() }); continue; }
    if (op === 0x42) { onInstr({ op: 'i64.const', value: r.sleb() }); continue; }
    if (op === 0x43) { const b = r.bytes_(4); onInstr({ op: 'f32.const', bytes: new Uint8Array(b) }); continue; }
    if (op === 0x44) { const b = r.bytes_(8); onInstr({ op: 'f64.const', bytes: new Uint8Array(b) }); continue; }

    // Reference types.
    if (op === 0xD0) { const ht = parseHeapType(r); onInstr({ op: 'ref.null', heap: ht }); continue; }
    if (op === 0xD2) { onInstr({ op: 'ref.func', funcidx: r.uleb() }); continue; }

    // GC / ref-type extension prefix.
    if (op === 0xFB) {
      const sub = r.uleb();
      const entry = _FB_OPS[sub];
      if (!entry) throw new Error(`walkInstructions: unknown 0xFB op 0x${sub.toString(16)}`);
      const [name, immKind] = entry;
      const out = { op: name };
      if (immKind === 'typeidx') {
        out.typeidx = r.uleb();
      } else if (immKind === 'typeidx+fieldidx') {
        out.typeidx = r.uleb(); out.fieldidx = r.uleb();
      } else if (immKind === 'typeidx+u32') {
        out.typeidx = r.uleb(); out.n = r.uleb();
      } else if (immKind === 'typeidx+typeidx') {
        out.dstTypeidx = r.uleb(); out.srcTypeidx = r.uleb();
      } else if (immKind === 'heaptype') {
        out.heap = parseHeapType(r);
      } else if (immKind === 'br_on_cast') {
        const flags = r.byte();
        out.castFlags = flags;
        out.fromHeap = parseHeapType(r);
        out.toHeap   = parseHeapType(r);
        out.target   = r.uleb();
      }
      onInstr(out);
      continue;
    }

    // Bulk memory + saturating-trunc + table extension prefix.
    if (op === 0xFC) {
      const sub = r.uleb();
      const entry = _FC_OPS[sub];
      if (!entry) throw new Error(`walkInstructions: unknown 0xFC op ${sub}`);
      const [name, immKind] = entry;
      const out = { op: name };
      if (immKind === 'dataidx+memidx') {
        out.dataidx = r.uleb(); out.memidx = r.uleb();
      } else if (immKind === 'dataidx') {
        out.dataidx = r.uleb();
      } else if (immKind === 'memidx+memidx') {
        out.dst = r.uleb(); out.src = r.uleb();
      } else if (immKind === 'memidx') {
        out.memidx = r.uleb();
      } else if (immKind === 'elemidx+tableidx') {
        out.elemidx = r.uleb(); out.tableidx = r.uleb();
      } else if (immKind === 'elemidx') {
        out.elemidx = r.uleb();
      } else if (immKind === 'tableidx+tableidx') {
        out.dstTable = r.uleb(); out.srcTable = r.uleb();
      } else if (immKind === 'tableidx') {
        out.tableidx = r.uleb();
      }
      onInstr(out);
      continue;
    }

    // SIMD (0xFD) and atomics/threads (0xFE) — we don't parse these.
    if (op === 0xFD) throw new Error(`walkInstructions: SIMD (0xFD) not supported`);
    if (op === 0xFE) throw new Error(`walkInstructions: atomics (0xFE) not supported`);

    throw new Error(`walkInstructions: unknown opcode 0x${op.toString(16)} at pos ${r.pos - 1}`);
  }
}

// Convenience: returns an array of opcode names for a function body.
function listOpcodes(body) {
  const ops = [];
  walkInstructions(body, i => ops.push(i.op));
  return ops;
}

// ─────────────────────────── Pretty-print helpers ───────────────────────────

function valueTypeToString(vt) {
  if (vt.kind === 'ref') {
    const heap = vt.heap.kind === 'abstract' ? vt.heap.name : `$${vt.heap.idx}`;
    return vt.nullable ? `(ref null ${heap})` : `(ref ${heap})`;
  }
  return vt.kind;
}

function typeToString(t, idx) {
  const tag = t.name ? `$${t.name}` : `$${idx}`;
  const supers = t.supers && t.supers.length ? ` (super $${t.supers.join(' $')})` : '';
  const finalTag = t.final ? '' : ' (open)';
  const head = `[${tag}]${supers}${finalTag} `;
  if (t.kind === 'func') {
    const params = t.params.map(valueTypeToString).join(' ');
    const results = t.results.map(valueTypeToString).join(' ');
    return `${head}func (${params}) -> (${results})`;
  }
  if (t.kind === 'struct') {
    const fields = t.fields.map(f => `${f.mut ? 'mut ' : ''}${valueTypeToString(f.type)}`).join(' ');
    return `${head}struct (${fields})`;
  }
  if (t.kind === 'array') {
    return `${head}array ${t.mut ? 'mut ' : ''}${valueTypeToString(t.element)}`;
  }
  return `${head}<unknown>`;
}

function summary(d) {
  const lines = [`wasm v${d.version}`];
  lines.push(`types (${d.types.length}):`);
  d.types.forEach((t, i) => lines.push('  ' + typeToString(t, i)));
  if (d.imports.length) {
    lines.push(`imports (${d.imports.length}):`);
    for (const im of d.imports) {
      const detail = im.kind === 'func' ? `typeidx $${im.typeidx}`
                  : im.kind === 'global' ? `${im.mut ? 'mut ' : ''}${valueTypeToString(im.valueType)}`
                  : '';
      const dbg = im.debugName ? ` (debug name: ${im.debugName})` : '';
      lines.push(`  ${im.module}.${im.name} : ${im.kind} ${detail}${dbg}`);
    }
  }
  if (d.exports.length) {
    lines.push(`exports (${d.exports.length}):`);
    for (const ex of d.exports) {
      lines.push(`  ${ex.name} : ${ex.kind} #${ex.idx}`);
    }
  }
  if (d.funcs.length) {
    lines.push(`funcs (${d.funcs.length}):`);
    d.funcs.forEach((f, i) => {
      const localCount = f.localGroups.reduce((acc, g) => acc + g.count, 0);
      const tag = f.name ? `$${f.name}` : `#${i}`;
      lines.push(`  ${tag} typeidx $${f.typeidx} locals=${localCount} body=${f.body.length}B`);
    });
  }
  return lines.join('\n');
}

// ─────────────────────────── Module export ───────────────────────────

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    disassemble, summary, valueTypeToString, typeToString,
    walkInstructions, listOpcodes,
  };
}
