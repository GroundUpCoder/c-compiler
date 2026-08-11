'use strict';
// PNG codec for the test estate (#657) — zero dependencies (node core zlib).
//
// The estate's screenshots are RGBA PNGs (`wmctl shot`/`wmctl thumb`,
// os/wmctl.c, encoded in-OS by the vendored libpng+zlib). This module is
// the host-side half of that contract:
//
//   parsePng(buf, off) -> { w, h, rgba, px, next }
//     w, h     dimensions
//     rgba     Buffer, 4 bytes/px, straight (non-premultiplied) RGBA;
//              truecolour (no-alpha) sources expand with a = 255
//     px(x,y)  -> [r, g, b, a]; out-of-range throws — a pixel assert must
//              never quietly read undefined
//     next     offset just past IEND, so a concatenated multi-shot stream
//              (several PNGs cat'd back-to-back) walks by re-calling
//              parsePng(buf, p.next)
//   encodePng(w, h, pixels) -> PNG Buffer — pixels is w*h*3 (RGB) or
//     w*h*4 (RGBA); used to persist synthesized evidence images.
//
// parsePng covers exactly what the estate's writers emit — 8-bit, colour
// type 2 (truecolour) or 6 (truecolour+alpha), non-interlaced — and THROWS
// on anything else: a malformed or truncated shot must fail the test, not
// decode to a quiet zero.
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/* Encode a packed RGB (3 bytes/px) or RGBA (4 bytes/px) buffer as an 8-bit
 * PNG (colour type 2 / 6 by the buffer's length). */
function encodePng(w, h, pixels) {
  const bpp = pixels.length === w * h * 4 ? 4 : 3;
  if (pixels.length !== w * h * bpp)
    throw new Error(`encodePng: ${pixels.length} bytes for ${w}x${h} (want RGB or RGBA)`);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;                    // bit depth
  ihdr[9] = bpp === 4 ? 6 : 2;    // colour type
  // raw scanlines, each prefixed with filter byte 0
  const raw = Buffer.alloc(h * (1 + w * bpp));
  for (let y = 0; y < h; y++)
    pixels.copy(raw, y * (1 + w * bpp) + 1, y * w * bpp, (y + 1) * w * bpp);
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* Paeth predictor (PNG spec 9.4). */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/* Parse one PNG from `buf` at `off`. Returns { w, h, rgba, px, next }. */
function parsePng(buf, off = 0) {
  if (buf.length < off + 8 || !buf.subarray(off, off + 8).equals(SIG))
    throw new Error('parsePng: no PNG signature at offset ' + off + ' (head: ' +
      buf.subarray(off, off + 8).toString('hex') + ')');
  let p = off + 8;
  let w = 0, h = 0, depth = 0, ctype = 0, interlace = 0;
  let sawIhdr = false, sawIend = false;
  const idat = [];
  while (!sawIend) {
    if (p + 8 > buf.length) throw new Error('parsePng: truncated at chunk header (offset ' + p + ')');
    const len = buf.readUInt32BE(p);
    const type = buf.toString('latin1', p + 4, p + 8);
    if (p + 12 + len > buf.length)
      throw new Error(`parsePng: truncated inside ${type} (${buf.length - p - 8} of ${len})`);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      depth = data[8];
      ctype = data[9];
      interlace = data[12];
      sawIhdr = true;
      if (depth !== 8 || (ctype !== 2 && ctype !== 6) || interlace !== 0)
        throw new Error(`parsePng: unsupported format (depth ${depth}, colour type ${ctype}, ` +
          `interlace ${interlace}) — the estate writes 8-bit RGB/RGBA non-interlaced`);
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      sawIend = true;
    }
    p += 12 + len;
  }
  if (!sawIhdr) throw new Error('parsePng: no IHDR');
  const bpp = ctype === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  if (raw.length !== h * (1 + stride))
    throw new Error(`parsePng: ${raw.length} filtered bytes for ${w}x${h}x${bpp} (want ${h * (1 + stride)})`);
  // Unfilter (spec 9: one filter byte per scanline, then the filtered row).
  const flat = Buffer.alloc(h * stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (1 + stride)];
    const rs = y * (1 + stride) + 1;
    const os = y * stride, ps = os - stride;
    switch (f) {
      case 0:
        raw.copy(flat, os, rs, rs + stride);
        break;
      case 1:   // Sub
        for (let i = 0; i < stride; i++)
          flat[os + i] = (raw[rs + i] + (i >= bpp ? flat[os + i - bpp] : 0)) & 0xff;
        break;
      case 2:   // Up
        for (let i = 0; i < stride; i++)
          flat[os + i] = (raw[rs + i] + (y > 0 ? flat[ps + i] : 0)) & 0xff;
        break;
      case 3:   // Average
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? flat[os + i - bpp] : 0;
          const b = y > 0 ? flat[ps + i] : 0;
          flat[os + i] = (raw[rs + i] + ((a + b) >> 1)) & 0xff;
        }
        break;
      case 4:   // Paeth
        for (let i = 0; i < stride; i++) {
          const a = i >= bpp ? flat[os + i - bpp] : 0;
          const b = y > 0 ? flat[ps + i] : 0;
          const c = y > 0 && i >= bpp ? flat[ps + i - bpp] : 0;
          flat[os + i] = (raw[rs + i] + paeth(a, b, c)) & 0xff;
        }
        break;
      default:
        throw new Error(`parsePng: bad filter type ${f} on row ${y}`);
    }
  }
  let rgba;
  if (bpp === 4) {
    rgba = flat;
  } else {
    rgba = Buffer.alloc(w * h * 4, 0xff);
    for (let i = 0, j = 0; i < flat.length; i += 3, j += 4) {
      rgba[j] = flat[i]; rgba[j + 1] = flat[i + 1]; rgba[j + 2] = flat[i + 2];
    }
  }
  const px = (x, y) => {
    if (!(x >= 0 && x < w && y >= 0 && y < h))
      throw new Error(`px(${x},${y}) out of ${w}x${h}`);
    const i = (y * w + x) * 4;
    return [rgba[i], rgba[i + 1], rgba[i + 2], rgba[i + 3]];
  };
  return { w, h, rgba, px, next: p };
}

module.exports = { encodePng, parsePng };
