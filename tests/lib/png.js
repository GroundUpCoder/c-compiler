'use strict';
// Minimal PNG encoder + PPM (P6) reader — zero dependencies (node core zlib).
//
// The estate's headless screenshots are raw P6 PPMs (`wmctl shot`), consumed
// in-memory by pixel asserts and never persisted viewably. This module is the
// missing persist step: encode an RGB buffer (or a P6 stream) as a real PNG a
// human can open. Used by the netsurf demos e2e to save failure/evidence
// shots, and by ad-hoc drivers.
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

/* Encode a packed RGB (3 bytes/px) buffer as an 8-bit truecolour PNG. */
function encodePng(w, h, rgb) {
  if (rgb.length !== w * h * 3) throw new Error(`encodePng: ${rgb.length} bytes for ${w}x${h}`);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 2;    // colour type: truecolour
  // raw scanlines, each prefixed with filter byte 0
  const raw = Buffer.alloc(h * (1 + w * 3));
  for (let y = 0; y < h; y++)
    rgb.copy(raw, y * (1 + w * 3) + 1, y * w * 3, (y + 1) * w * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* Parse one binary P6 PPM (maxval 255) from `buf` at `off`.
 * Returns { w, h, rgb, next } — `next` is the offset just past the pixels,
 * so a concatenated multi-shot stream can be walked. */
function parsePpm(buf, off = 0) {
  const head = buf.toString('latin1', off, off + 32);
  const m = head.match(/^P6\n(\d+) (\d+)\n255\n/);
  if (!m) throw new Error('parsePpm: bad P6 header: ' + JSON.stringify(head.slice(0, 20)));
  const w = +m[1], h = +m[2];
  const data = off + m[0].length;
  const next = data + w * h * 3;
  if (next > buf.length) throw new Error(`parsePpm: truncated pixels (${buf.length - data} of ${w * h * 3})`);
  return { w, h, rgb: buf.subarray(data, next), next };
}

/* One-call PPM buffer -> PNG buffer. */
function ppmToPng(ppm) {
  const { w, h, rgb } = parsePpm(ppm);
  return encodePng(w, h, rgb);
}

module.exports = { encodePng, parsePpm, ppmToPng };
