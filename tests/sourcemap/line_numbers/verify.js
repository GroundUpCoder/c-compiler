const fs = require('fs');

const wasmPath = process.argv[2];
if (!wasmPath) { console.error('usage: verify.js <wasm>'); process.exit(1); }
const bytes = new Uint8Array(fs.readFileSync(wasmPath));

// Parse c.sourcemap custom section
let pos = 8;
function readLEB() {
  let r = 0, s = 0, b;
  do { b = bytes[pos++]; r |= (b & 0x7F) << s; s += 7; } while (b & 0x80);
  return r;
}
function readLEBI() {
  let r = 0, s = 0, b;
  do { b = bytes[pos++]; r |= (b & 0x7F) << s; s += 7; } while (b & 0x80);
  if (s < 32 && (b & 0x40)) r |= (~0 << s);
  return r;
}
function readString() {
  const len = readLEB();
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[pos++]);
  return s;
}

// Parse name section to get function index -> name mapping
let funcNames = {};
let nameSecPos = 8;
function parseSections() {
  let p = 8;
  while (p < bytes.length) {
    const id = bytes[p++];
    let sz = 0, sh = 0, b;
    do { b = bytes[p++]; sz |= (b & 0x7F) << sh; sh += 7; } while (b & 0x80);
    const end = p + sz;
    if (id === 0) {
      const savedPos = pos;
      pos = p;
      const name = readString();
      if (name === 'name') {
        while (pos < end) {
          const subId = bytes[pos++];
          const subSz = readLEB();
          const subEnd = pos + subSz;
          if (subId === 1) {
            const count = readLEB();
            for (let i = 0; i < count; i++) {
              const idx = readLEB();
              const fname = readString();
              funcNames[idx] = fname;
            }
          }
          pos = subEnd;
        }
      }
      pos = savedPos;
    }
    p = end;
  }
}
parseSections();

// Parse c.sourcemap
let sourceMap = null;
pos = 8;
while (pos < bytes.length) {
  const id = bytes[pos++];
  const size = readLEB();
  const end = pos + size;
  if (id === 0) {
    const name = readString();
    if (name === 'c.sourcemap') {
      const fileCount = readLEB();
      const files = [];
      for (let i = 0; i < fileCount; i++) files.push(readString());
      const entryCount = readLEB();
      const entries = [];
      let absOff = 0, absFile = 0, absLine = 0;
      for (let i = 0; i < entryCount; i++) {
        if (i === 0) { absOff = readLEB(); absFile = readLEB(); absLine = readLEB(); }
        else { absOff += readLEB(); absFile += readLEBI(); absLine += readLEBI(); }
        entries.push({ offset: absOff, file: files[absFile], line: absLine });
      }
      sourceMap = { files, entries };
      break;
    }
  }
  pos = end;
}

if (!sourceMap) {
  console.error('FAIL: no c.sourcemap section found');
  process.exit(1);
}

// Parse code section to get function body offset ranges
let codeSectionFuncs = [];
pos = 8;
while (pos < bytes.length) {
  const id = bytes[pos++];
  const size = readLEB();
  const end = pos + size;
  if (id === 10) {
    const count = readLEB();
    for (let i = 0; i < count; i++) {
      const bodySize = readLEB();
      const bodyStart = pos;
      codeSectionFuncs.push({ start: bodyStart, end: bodyStart + bodySize });
      pos = bodyStart + bodySize;
    }
    break;
  }
  pos = end;
}

// Find import count to map code func index to absolute func index
let importCount = 0;
pos = 8;
while (pos < bytes.length) {
  const id = bytes[pos++];
  const size = readLEB();
  const end = pos + size;
  if (id === 2) {
    const count = readLEB();
    for (let i = 0; i < count; i++) {
      readString(); readString();
      const kind = bytes[pos++];
      if (kind === 0) { readLEB(); importCount++; }
      else if (kind === 1) { pos += 3; }
      else if (kind === 2) { pos += 2; }
      else if (kind === 3) { pos += 2; }
    }
    break;
  }
  pos = end;
}

// Group sourcemap entries by code function
function entriesForFunc(codeFuncIdx) {
  const f = codeSectionFuncs[codeFuncIdx];
  if (!f) return [];
  return sourceMap.entries.filter(e => e.offset >= f.start && e.offset < f.end);
}

// Known line numbers from main.c
const FUNC_LINES = {
  'add': 1,
  'sub': 3,
  'use_stack': 7,
  'main': 12,
};

let errors = [];

for (const [name, declLine] of Object.entries(FUNC_LINES)) {
  let codeFuncIdx = null;
  for (const [absIdx, fname] of Object.entries(funcNames)) {
    if (fname === name) {
      codeFuncIdx = Number(absIdx) - importCount;
      break;
    }
  }
  if (codeFuncIdx === null || codeFuncIdx < 0) {
    errors.push(`${name}: could not find function index`);
    continue;
  }

  const entries = entriesForFunc(codeFuncIdx);
  if (entries.length === 0) {
    errors.push(`${name}: no sourcemap entries`);
    continue;
  }

  const firstLine = entries[0].line;
  if (firstLine !== declLine) {
    errors.push(`${name}: first sourcemap entry is line ${firstLine}, expected ${declLine} (declaration line)`);
  }

  // Verify no entry references a line from a different function's range
  const funcLineRanges = Object.entries(FUNC_LINES).sort((a, b) => a[1] - b[1]);
  for (const entry of entries) {
    let ownerFunc = null;
    for (let i = funcLineRanges.length - 1; i >= 0; i--) {
      if (entry.line >= funcLineRanges[i][1]) { ownerFunc = funcLineRanges[i][0]; break; }
    }
    if (ownerFunc && ownerFunc !== name) {
      errors.push(`${name}: entry at offset ${entry.offset} references line ${entry.line} which belongs to '${ownerFunc}'`);
      break;
    }
  }
}

if (errors.length > 0) {
  for (const e of errors) console.log('FAIL: ' + e);
  process.exit(1);
} else {
  console.log('OK: sourcemap line numbers correct');
  process.exit(0);
}
