#!/usr/bin/env node
// mkgif.js — synthesize the committed static-GIF test asset for the
// MagicPoint present demo (todos/0119 giflib follow-up), the mksounds.js
// precedent: a committed Node generator so the fixture is reproducible
// anywhere with Node, no image toolchain. Writes vendor/magicpoint/demo.gif:
// a 200x150 GIF89a split left-half magenta / right-half cyan — two colours
// used on no other demo slide, so the present e2e can assert "the GIF page
// rendered" purely from pixel counts.
//
// Minimal GIF LZW encoder (variable-width, LSB-first, no early-change — the
// GIF rule, distinct from TIFF), following the well-tested omggif shape.

'use strict';
const fs = require('fs');
const path = require('path');

// Cross-tree preflight (todos/0341, extended by #142): writes the committed
// vendor/magicpoint/demo.gif next to itself. Hand-run only.
require(path.join(__dirname, '../tests/lib/tree-guard.js'))
  .assertSameTree(__dirname, { label: 'tools/mkgif.js' });

const W = 200, H = 150;
// 4-entry palette (power-of-two, min code size 2): 0=magenta 1=cyan 2,3=pad.
const PALETTE = [
  [255, 0, 255], // 0 magenta
  [0, 255, 255], // 1 cyan
  [0, 0, 0],     // 2 pad
  [0, 0, 0],     // 3 pad
];

// index raster: left half index 0, right half index 1
const idx = new Uint8Array(W * H);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++)
    idx[y * W + x] = x < W / 2 ? 0 : 1;

function lzwEncode(indexStream, minCodeSize) {
  const out = [];
  let cur = 0, curShift = 0;
  function emitCode(code, size) {
    cur |= code << curShift;
    curShift += size;
    while (curShift >= 8) { out.push(cur & 0xff); cur >>= 8; curShift -= 8; }
  }
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let curCodeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  let table = Object.create(null);

  emitCode(clearCode, curCodeSize);
  let ib = indexStream[0];
  for (let i = 1; i < indexStream.length; i++) {
    const k = indexStream[i];
    const key = (ib << 8) | k;
    const code = table[key];
    if (code !== undefined) {
      ib = code;
    } else {
      emitCode(ib, curCodeSize);
      if (nextCode === 4096) {
        emitCode(clearCode, curCodeSize);
        table = Object.create(null);
        nextCode = eoiCode + 1;
        curCodeSize = minCodeSize + 1;
      } else {
        if (nextCode >= (1 << curCodeSize)) curCodeSize++;
        table[key] = nextCode++;
      }
      ib = k;
    }
  }
  emitCode(ib, curCodeSize);
  emitCode(eoiCode, curCodeSize);
  if (curShift > 0) out.push(cur & 0xff);
  return out;
}

const bytes = [];
const push = (...b) => b.forEach((x) => bytes.push(x & 0xff));
const push16 = (v) => { bytes.push(v & 0xff, (v >> 8) & 0xff); };

// Header
'GIF89a'.split('').forEach((c) => bytes.push(c.charCodeAt(0)));
// Logical Screen Descriptor: GCT present, colorRes 1, sort 0, GCT size field
// = log2(4)-1 = 1 (=> packed 0x80|0x01=0x81 with colorRes bits, keep simple).
push16(W); push16(H);
const gctSizeField = 1;          // 2^(1+1)=4 entries
push(0x80 | (0x00 << 4) | gctSizeField); // global color table flag + size
push(0);                          // background color index
push(0);                          // pixel aspect ratio
// Global Color Table (4 * RGB)
PALETTE.forEach(([r, g, b]) => push(r, g, b));
// Image Descriptor
push(0x2c);                       // image separator
push16(0); push16(0);             // left, top
push16(W); push16(H);
push(0x00);                       // no local color table, not interlaced
// Image data
const minCodeSize = 2;
push(minCodeSize);
const lzw = lzwEncode(idx, minCodeSize);
for (let i = 0; i < lzw.length; i += 255) {
  const chunk = lzw.slice(i, i + 255);
  push(chunk.length);
  chunk.forEach((b) => bytes.push(b));
}
push(0x00);                       // block terminator
push(0x3b);                       // trailer

const outPath = path.join(__dirname, '..', 'vendor', 'magicpoint', 'demo.gif');
fs.writeFileSync(outPath, Buffer.from(bytes));
console.log(`wrote ${outPath} (${bytes.length} bytes, ${W}x${H} GIF89a)`);
