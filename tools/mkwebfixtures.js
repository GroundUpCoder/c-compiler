#!/usr/bin/env node
// mkwebfixtures.js — synthesize the committed NetSurf image-decode test
// fixtures (NetSurf Lane 4), the mkgif.js/mksounds.js precedent: a
// committed Node generator so every binary fixture is reproducible
// anywhere with Node, no image toolchain, byte-deterministic (no
// timestamps, fixed encoder settings).
//
// Writes vendor/netsurf/test/img/{red.gif,green.bmp,blue.ico,orange.png}
// — one 32x32 solid-colour image per IN-TREE decoder (libnsgif, libnsbmp
// BMP + ICO, libpng-in-core PNG; JPEG is deliberately absent: no WITH_JPEG
// in netsurf-core.json, no vendored libjpeg) — plus
// vendor/netsurf/test/images.html, which embeds all four via <img>, a
// fifth image as a base64 data: URI (8x8 solid magenta GIF, the data-
// fetcher leg) and a scaled re-use of red.gif (the scaled-bitmap plot
// path). test_netsurf_content_e2e.js asserts the decoded colours land on
// the framebuffer at the stacked block offsets below.
//
// Colour per format (probe-distinct, chosen against the e2e's colour
// predicates): GIF #ff0000, BMP #00c800, ICO #0000ff, PNG #ff8000,
// data-URI GIF #ff00ff.
'use strict';
const fs = require('fs');
const path = require('path');

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

/* ---------------- write the estate --------------------------------- */

fs.mkdirSync(OUTDIR, { recursive: true });
const files = {
  'red.gif': makeGif(S, S, [0xff, 0x00, 0x00]),
  'green.bmp': makeBmp(S, S, [0x00, 0xc8, 0x00]),
  'blue.ico': makeIco(S, S, [0x00, 0x00, 0xff]),
  'orange.png': makePng(S, S, [0xff, 0x80, 0x00]),
};
for (const [name, buf] of Object.entries(files)) {
  fs.writeFileSync(path.join(OUTDIR, name), buf);
  console.log(`wrote ${path.join(OUTDIR, name)} (${buf.length} bytes)`);
}

/* images.html — the in-app decode page. Blocks stack at y = 0, 32, 64,
 * 96, 128 (each img display:block, margin 0), then the scaled red.gif
 * (64x64) at y 160. The data: URI is the 8x8 magenta GIF generated
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
</body>
</html>
`;
const htmlPath = path.join(OUTDIR, '..', 'images.html');
fs.writeFileSync(htmlPath, html);
console.log(`wrote ${htmlPath} (${html.length} bytes)`);
