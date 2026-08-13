#!/usr/bin/env node
'use strict';
// #657: tests/lib/png.js — the estate's screenshot decode/assert substrate.
//
// `wmctl shot`/`wmctl thumb` write RGBA PNG via the vendored libpng, and
// every pixel assert in the kernel e2es decodes through parsePng. libpng
// emits FILTERED scanlines (its heuristic picks per-row from types 0-4), so
// this test proves the decoder against the PNG spec's filter definitions —
// each filter is applied FORWARD here from the spec text, independently of
// the decoder's inverse — not merely against our own filter-0 encoder.
//
// The positive controls are the point (the acceptance criterion): a decoder
// that "parses fine" proves nothing. Control 1 shows a one-pixel change in
// an otherwise identical PNG is DETECTED by the px() assert idiom the tests
// use; controls 2-4 show malformed input (truncation, bad filter byte,
// unsupported format, CRC mismatch — #659) throws loudly instead of
// decoding to a quiet zero.
//
// Run: node tests/host/test_png_helper.js

const zlib = require('zlib');
const { encodePng, parsePng } = require('../lib/png.js');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { console.log('ok - ' + name); return; }
  failures++;
  console.log('FAIL - ' + name + (detail !== undefined ? ' :: ' + detail : ''));
}
function throws(name, fn, re) {
  try { fn(); check(name, false, 'did not throw'); }
  catch (e) { check(name, re.test(e.message), e.message); }
}

// CRC + chunk assembly re-derived from the PNG spec here, INDEPENDENTLY of
// png.js's own table — the hand-built fixtures must not certify the decoder
// with its own arithmetic.
const crcT = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
const crc32 = (b) => {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcT[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
};

// A deterministic 7x5 RGBA test card: every channel varies with position so
// any pixel swap or channel transposition changes some asserted value.
const W = 7, H = 5;
const card = Buffer.alloc(W * H * 4);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    card[i] = 17 * x + 3;
    card[i + 1] = 29 * y + 5;
    card[i + 2] = (13 * x * y + 7) & 0xff;
    card[i + 3] = 255 - 11 * x;         // non-opaque alpha — must survive
  }

// ---- 1. round trip through our own encoder (filter 0), RGBA + RGB ----
{
  const p = parsePng(encodePng(W, H, card));
  check('rgba round trip dims', p.w === W && p.h === H, p.w + 'x' + p.h);
  check('rgba round trip bytes', p.rgba.equals(card));
  check('px() reads the card', String(p.px(3, 2)) === String([17 * 3 + 3, 29 * 2 + 5, (13 * 6 + 7) & 0xff, 255 - 33]),
        String(p.px(3, 2)));
  check('alpha preserved (non-255)', p.px(6, 0)[3] === 255 - 66, p.px(6, 0)[3]);

  const rgb = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) card.copy(rgb, i * 3, i * 4, i * 4 + 3);
  const q = parsePng(encodePng(W, H, rgb));
  check('rgb source expands with a=255', q.px(2, 4)[3] === 255 && String(q.px(2, 4).slice(0, 3)) === String(p.px(2, 4).slice(0, 3)),
        String(q.px(2, 4)));
}

// ---- 2. spec-filtered scanlines decode (types 0-4 applied FORWARD) ----
// Build the filtered stream by the spec's definitions (9.2): for each row y,
// Filt(x) = Orig(x) - predictor(a, b, c) mod 256, a/b/c = left/up/up-left
// bytes at distance bpp. Row y uses filter type y (0=None, 1=Sub, 2=Up,
// 3=Average, 4=Paeth) — one row of each on a 5-row image.
{
  const bpp = 4, stride = W * bpp;
  const raw = Buffer.alloc(H * (1 + stride));
  const paeth = (a, b, c) => {
    const pp = a + b - c;
    const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
    return (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
  };
  for (let y = 0; y < H; y++) {
    raw[y * (1 + stride)] = y;          // filter type = row index
    for (let i = 0; i < stride; i++) {
      const orig = card[y * stride + i];
      const a = i >= bpp ? card[y * stride + i - bpp] : 0;
      const b = y > 0 ? card[(y - 1) * stride + i] : 0;
      const c = (y > 0 && i >= bpp) ? card[(y - 1) * stride + i - bpp] : 0;
      const pred = y === 0 ? 0 : y === 1 ? a : y === 2 ? b
                 : y === 3 ? ((a + b) >> 1) : paeth(a, b, c);
      raw[y * (1 + stride) + 1 + i] = (orig - pred) & 0xff;
    }
  }
  // Assemble a whole PNG around the hand-filtered stream.
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  const p = parsePng(png);
  check('all five spec filters unfilter to the original', p.rgba.equals(card));
}

// ---- 3. multi-image stream walk (concatenated shots) ----
{
  const a = encodePng(W, H, card);
  const b = encodePng(2, 2, Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
  const stream = Buffer.concat([a, b]);
  const p1 = parsePng(stream, 0);
  check('stream: first image ends where the second begins', p1.next === a.length, p1.next);
  const p2 = parsePng(stream, p1.next);
  check('stream: second image decodes', p2.w === 2 && p2.h === 2 && p2.next === stream.length,
        p2.w + 'x' + p2.h + ' next=' + p2.next);
  check('stream: second image pixels', String(p2.px(1, 1)) === String([10, 11, 12, 255]),
        String(p2.px(1, 1)));
}

// ---- 4. POSITIVE CONTROLS ----
// (a) The assert idiom must FAIL on an intentionally changed pixel: two PNGs
// identical except one pixel — the px()-equality the e2es rely on detects it.
{
  const tampered = Buffer.from(card);
  tampered[(2 * W + 4) * 4 + 1] ^= 0x40;               // green of (4,2)
  const good = parsePng(encodePng(W, H, card));
  const bad = parsePng(encodePng(W, H, tampered));
  const same = (x, y) => String(good.px(x, y)) === String(bad.px(x, y));
  check('CONTROL: changed pixel is detected', !same(4, 2),
        'tampered pixel compared equal — the helper proves nothing');
  check('CONTROL: neighbour pixels still equal', same(3, 2) && same(4, 1) && same(5, 3));
  check('CONTROL: whole-buffer compare detects it too', !good.rgba.equals(bad.rgba));
}
// (b) Truncation throws — a short read must never decode as success.
{
  const png = encodePng(W, H, card);
  throws('CONTROL: truncated stream throws', () => parsePng(png.subarray(0, png.length - 20)),
         /truncated/);
  throws('CONTROL: garbage throws (no signature)', () => parsePng(Buffer.from('P6\n7 5\n255\n')),
         /no PNG signature/);
}
// (c) Unsupported formats refuse by name (never a silently-wrong decode).
{
  const png = encodePng(W, H, card);
  const evil = Buffer.from(png);
  evil[8 + 8 + 9] = 3;                                  // IHDR colour type -> palette
  // re-seal the IHDR CRC over the mutated data (#659): parsePng now verifies
  // CRCs first, and the guard under test here is the FORMAT check
  evil.writeUInt32BE(crc32(evil.subarray(8 + 4, 8 + 8 + 13)), 8 + 8 + 13);
  throws('CONTROL: palette PNG refuses', () => parsePng(evil), /unsupported format/);
  throws('CONTROL: bad filter byte throws', () => {
    // hand-build: valid IHDR, IDAT whose first filter byte is 9
    const raw = Buffer.alloc(H * (1 + W * 4));
    raw[0] = 9;
    const ihdr = Buffer.from(png.subarray(8, 8 + 25));  // whole IHDR chunk
    parsePng(Buffer.concat([png.subarray(0, 8), ihdr,
                            chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  }, /bad filter type 9/);
}
// (d) CRC validation (#659): a chunk whose stored CRC disagrees with its
// contents throws, naming the chunk — even where the damage would still
// decode (the Codex #657 repro: a corrupted IHDR CRC was ACCEPTED pre-fix
// and returned the original pixels).
{
  const png = encodePng(W, H, card);
  const ihdrCrc = Buffer.from(png);
  ihdrCrc[8 + 8 + 13] ^= 0xff;               // first byte of the IHDR CRC field
  throws('CONTROL: corrupted IHDR CRC throws', () => parsePng(ihdrCrc), /CRC mismatch in IHDR/);
  const idatCrc = Buffer.from(png);
  idatCrc[png.length - 12 - 1] ^= 0xff;      // last byte of the IDAT CRC (IEND is the final 12)
  throws('CONTROL: corrupted IDAT CRC throws', () => parsePng(idatCrc), /CRC mismatch in IDAT/);
}
// (e) px() bounds: out of range throws rather than reading undefined.
{
  const p = parsePng(encodePng(W, H, card));
  throws('CONTROL: px() out of range throws', () => p.px(W, 0), /out of/);
}

if (failures) { console.log(failures + ' failure(s)'); process.exit(1); }
console.log('test_png_helper: all green');
