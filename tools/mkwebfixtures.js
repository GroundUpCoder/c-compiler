#!/usr/bin/env node
// mkwebfixtures.js — synthesize the committed NetSurf image-decode test
// fixtures (NetSurf Lane 4), the mkgif.js/mksounds.js precedent: a
// committed Node generator so every binary fixture is reproducible
// anywhere with Node, no image toolchain, byte-deterministic (no
// timestamps, fixed encoder settings).
//
// Writes vendor/netsurf/test/img/{red.gif,green.bmp,blue.ico,orange.png,
// teal.jpg} — one 32x32 solid-colour image per IN-TREE decoder (libnsgif,
// libnsbmp BMP + ICO, libpng-in-core PNG, libjpeg-in-core JPEG since
// 0448/#93) — plus vendor/netsurf/test/images.html, which embeds all five
// via <img>, a sixth image as a base64 data: URI (8x8 solid magenta GIF,
// the data-fetcher leg) and a scaled re-use of red.gif (the scaled-bitmap
// plot path). test_netsurf_content_e2e.js asserts the decoded colours land
// on the framebuffer at the stacked block offsets below.
//
// Colour per format (probe-distinct, chosen against the e2e's colour
// predicates): GIF #ff0000, BMP #00c800, ICO #0000ff, PNG #ff8000,
// JPEG #008080, data-URI GIF #ff00ff.
'use strict';
const fs = require('fs');
const path = require('path');

// Cross-tree preflight (todos/0341, extended by #142): writes the committed
// NetSurf image fixtures next to itself. Hand-run only.
require(path.join(__dirname, '../tests/lib/tree-guard.js'))
  .assertSameTree(__dirname, { label: 'tools/mkwebfixtures.js' });

const OUTDIR = path.join(__dirname, '..', 'vendor', 'netsurf', 'test', 'img');
const S = 32; /* fixture edge, px */

/* ---------------- GIF (the mkgif.js encoder, solid frame) ---------- */

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

function makeGif(w, h, rgb) {
  const bytes = [];
  const push = (...b) => b.forEach((x) => bytes.push(x & 0xff));
  const push16 = (v) => { bytes.push(v & 0xff, (v >> 8) & 0xff); };
  'GIF89a'.split('').forEach((c) => bytes.push(c.charCodeAt(0)));
  push16(w); push16(h);
  push(0x80 | 0x01);            // GCT present, 4 entries
  push(0); push(0);             // background index, aspect
  push(rgb[0], rgb[1], rgb[2]); // palette 0: the colour
  push(0, 0, 0); push(0, 0, 0); push(0, 0, 0); // pad entries
  push(0x2c);                   // image descriptor
  push16(0); push16(0); push16(w); push16(h); push(0x00);
  const minCodeSize = 2;
  push(minCodeSize);
  const lzw = lzwEncode(new Uint8Array(w * h), minCodeSize);
  for (let i = 0; i < lzw.length; i += 255) {
    const chunk = lzw.slice(i, i + 255);
    push(chunk.length);
    chunk.forEach((b) => bytes.push(b));
  }
  push(0x00); push(0x3b);
  return Buffer.from(bytes);
}

/* ---------------- BMP (24bpp BI_RGB, bottom-up) -------------------- */

function makeBmp(w, h, rgb) {
  const rowBytes = (w * 3 + 3) & ~3;
  const dataSize = rowBytes * h;
  const buf = Buffer.alloc(14 + 40 + dataSize);
  buf.write('BM', 0);
  buf.writeUInt32LE(buf.length, 2);
  buf.writeUInt32LE(14 + 40, 10);        // pixel data offset
  buf.writeUInt32LE(40, 14);             // BITMAPINFOHEADER
  buf.writeInt32LE(w, 18);
  buf.writeInt32LE(h, 22);
  buf.writeUInt16LE(1, 26);              // planes
  buf.writeUInt16LE(24, 28);             // bpp
  buf.writeUInt32LE(0, 30);              // BI_RGB
  buf.writeUInt32LE(dataSize, 34);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const off = 14 + 40 + y * rowBytes + x * 3;
      buf[off] = rgb[2]; buf[off + 1] = rgb[1]; buf[off + 2] = rgb[0];
    }
  }
  return buf;
}

/* ---------------- ICO (one 32bpp BMP-in-ICO entry) ----------------- */

function makeIco(w, h, rgb) {
  const xorBytes = w * 4 * h;
  const andRow = ((w + 31) >> 5) * 4;    // 1bpp AND mask, 4-byte aligned
  const andBytes = andRow * h;
  const imgSize = 40 + xorBytes + andBytes;
  const buf = Buffer.alloc(6 + 16 + imgSize);
  buf.writeUInt16LE(0, 0);               // reserved
  buf.writeUInt16LE(1, 2);               // ICO
  buf.writeUInt16LE(1, 4);               // one image
  buf[6] = w & 0xff; buf[7] = h & 0xff;  // 0 would mean 256
  buf[8] = 0; buf[9] = 0;                // colours, reserved
  buf.writeUInt16LE(1, 10);              // planes
  buf.writeUInt16LE(32, 12);             // bpp
  buf.writeUInt32LE(imgSize, 14);
  buf.writeUInt32LE(6 + 16, 18);         // image offset
  const ih = 6 + 16;
  buf.writeUInt32LE(40, ih);
  buf.writeInt32LE(w, ih + 4);
  buf.writeInt32LE(h * 2, ih + 8);       // XOR+AND doubled height
  buf.writeUInt16LE(1, ih + 12);
  buf.writeUInt16LE(32, ih + 14);
  buf.writeUInt32LE(0, ih + 16);         // BI_RGB
  buf.writeUInt32LE(xorBytes + andBytes, ih + 20);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const off = ih + 40 + (y * w + x) * 4;
      buf[off] = rgb[2]; buf[off + 1] = rgb[1];
      buf[off + 2] = rgb[0]; buf[off + 3] = 0xff; // opaque alpha
    }
  }
  /* AND mask stays all-zero = fully opaque */
  return buf;
}

/* ---------------- PNG (RGB8, stored-deflate zlib — no lib) --------- */

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function adler32(buf) {
  let a = 1, b = 0;
  for (let i = 0; i < buf.length; i++) { a = (a + buf[i]) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}
function chunk(type, data) {
  const buf = Buffer.alloc(8 + data.length + 4);
  buf.writeUInt32BE(data.length, 0);
  buf.write(type, 4);
  data.copy(buf, 8);
  buf.writeUInt32BE(crc32(buf.slice(4, 8 + data.length)), 8 + data.length);
  return buf;
}
function makePng(w, h, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2;              // 8-bit, truecolour
  const raw = Buffer.alloc(h * (1 + w * 3)); // filter byte 0 + RGB rows
  for (let y = 0; y < h; y++) {
    const row = y * (1 + w * 3) + 1;
    for (let x = 0; x < w; x++) {
      raw[row + x * 3] = rgb[0]; raw[row + x * 3 + 1] = rgb[1];
      raw[row + x * 3 + 2] = rgb[2];
    }
  }
  /* zlib stream: header + stored-deflate blocks (fully deterministic —
   * no dependence on any deflate implementation) + adler32 */
  const blocks = [];
  for (let off = 0; off < raw.length; off += 65535) {
    const n = Math.min(65535, raw.length - off);
    const head = Buffer.alloc(5);
    head[0] = (off + n >= raw.length) ? 1 : 0; // BFINAL
    head.writeUInt16LE(n, 1);
    head.writeUInt16LE(~n & 0xffff, 3);
    blocks.push(head, raw.slice(off, off + n));
  }
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(adler32(raw), 0);
  const idat = Buffer.concat([Buffer.from([0x78, 0x01]), ...blocks, tail]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- JPEG (baseline, DC-only blocks, no lib) ---------- */

/* A solid colour needs only DC coefficients: with an all-ones quant table
 * the flat 8x8 DCT stores (v-128)*8 exactly and the IDCT reconstructs v
 * exactly, so the decode error is just the YCbCr round trip (±1). Tables
 * are the JPEG Annex K standard luminance pair; every component uses
 * table 0 — fully deterministic, no encoder library. */

const DC_BITS = [0, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0];
const DC_VALS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const AC_BITS = [0, 0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d];
const AC_VALS = [
  0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06,
  0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
  0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
  0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
  0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45,
  0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
  0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
  0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
  0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3,
  0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
  0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9,
  0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
  0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4,
  0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
];

function buildHuff(bits, vals) {
  const map = {};
  let code = 0, k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len]; i++) { map[vals[k++]] = { code, len }; code++; }
    code <<= 1;
  }
  return map;
}

function makeJpeg(w, h, rgb) {
  const [r, g, b] = rgb;
  /* JFIF (BT.601) RGB -> YCbCr of the one flat colour */
  const ycc = [
    Math.round(0.299 * r + 0.587 * g + 0.114 * b),
    Math.round(128 - 0.168736 * r - 0.331264 * g + 0.5 * b),
    Math.round(128 + 0.5 * r - 0.418688 * g - 0.081312 * b),
  ].map((v) => Math.max(0, Math.min(255, v)));

  const bytes = [];
  const push = (...v) => v.forEach((x) => bytes.push(x & 0xff));
  const push16 = (v) => push(v >> 8, v);
  const marker = (m, data) => { push(0xff, m); push16(data.length + 2); data.forEach((x) => push(x)); };

  push(0xff, 0xd8);                                    // SOI
  marker(0xe0, [0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]); // APP0 JFIF
  marker(0xdb, [0, ...new Array(64).fill(1)]);         // DQT 0, all ones
  marker(0xc0, [8, h >> 8, h & 0xff, w >> 8, w & 0xff, 3,
                1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);  // SOF0, 3x 1x1 sampling
  marker(0xc4, [0x00, ...DC_BITS.slice(1), ...DC_VALS,
                0x10, ...AC_BITS.slice(1), ...AC_VALS]); // DHT: DC0 + AC0
  marker(0xda, [3, 1, 0x00, 2, 0x00, 3, 0x00, 0, 63, 0]); // SOS

  const dcHuff = buildHuff(DC_BITS, DC_VALS);
  const eob = buildHuff(AC_BITS, AC_VALS)[0x00];
  let acc = 0, nbits = 0;
  const emit = (code, len) => {
    acc = (acc << len) | code; nbits += len;
    while (nbits >= 8) {
      const byte = (acc >> (nbits - 8)) & 0xff;
      push(byte); if (byte === 0xff) push(0x00);       // byte stuffing
      nbits -= 8;
    }
    acc &= (1 << nbits) - 1;   // drop emitted bits (JS << wraps at 32)
  };
  const mcus = (w >> 3) * (h >> 3);
  for (let m = 0; m < mcus; m++) {
    for (let c = 0; c < 3; c++) {
      let diff = m === 0 ? (ycc[c] - 128) * 8 : 0;     // DC predictor: flat
      let size = 0;
      for (let v = Math.abs(diff); v; v >>= 1) size++;
      const hc = dcHuff[size];
      emit(hc.code, hc.len);
      if (size) emit(diff < 0 ? diff + (1 << size) - 1 : diff, size);
      emit(eob.code, eob.len);                          // no AC coefficients
    }
  }
  if (nbits) emit((1 << (8 - nbits)) - 1, 8 - nbits);  // pad with 1-bits
  push(0xff, 0xd9);                                    // EOI
  return Buffer.from(bytes);
}

/* ---------------- write the estate --------------------------------- */

fs.mkdirSync(OUTDIR, { recursive: true });
const files = {
  'red.gif': makeGif(S, S, [0xff, 0x00, 0x00]),
  'green.bmp': makeBmp(S, S, [0x00, 0xc8, 0x00]),
  'blue.ico': makeIco(S, S, [0x00, 0x00, 0xff]),
  'orange.png': makePng(S, S, [0xff, 0x80, 0x00]),
  'teal.jpg': makeJpeg(S, S, [0x00, 0x80, 0x80]),
};
for (const [name, buf] of Object.entries(files)) {
  fs.writeFileSync(path.join(OUTDIR, name), buf);
  console.log(`wrote ${path.join(OUTDIR, name)} (${buf.length} bytes)`);
}

/* images.html — the in-app decode page. Blocks stack at y = 0, 32, 64,
 * 96, 128 (each img display:block, margin 0), then the scaled red.gif
 * (64x64) at y 160 and the JPEG at y 224 (appended last so the earlier
 * offsets never move). The data: URI is the 8x8 magenta GIF generated
 * right here, so the whole page regenerates from this one script. */
const dataUri = 'data:image/gif;base64,' +
  makeGif(8, 8, [0xff, 0x00, 0xff]).toString('base64');
const html = `<!DOCTYPE html>
<!-- generated by tools/mkwebfixtures.js - do not hand-edit -->
<html>
<head><title>Images</title></head>
<body style="margin:0;background:#ffffff">
<img style="display:block" src="img/red.gif" alt="gif">
<img style="display:block" src="img/green.bmp" alt="bmp">
<img style="display:block" src="img/blue.ico" alt="ico">
<img style="display:block" src="img/orange.png" alt="png">
<img style="display:block" src="${dataUri}" alt="datauri" width="32" height="32">
<img style="display:block" src="img/red.gif" alt="scaled" width="64" height="64">
<img style="display:block" src="img/teal.jpg" alt="jpeg">
</body>
</html>
`;
const htmlPath = path.join(OUTDIR, '..', 'images.html');
fs.writeFileSync(htmlPath, html);
console.log(`wrote ${htmlPath} (${html.length} bytes)`);
