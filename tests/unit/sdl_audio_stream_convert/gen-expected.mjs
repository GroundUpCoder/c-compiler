#!/usr/bin/env node
// Independent oracle for main.c (#722 / #529-A). Emits expected.stdout.
//
// Independence: the channel coefficients below are extracted from the pinned
// SDL release-3.4.0 GENERATOR table (build-scripts/
// gen_audio_channel_conversion.c, the FAudio matrix_defaults table) — a
// different file from the generated converters the C implementation was
// transcribed from, so a mistranscription on either path fails the compare.
// Float arithmetic mirrors the documented pipeline exactly via Math.fround;
// the integer encoders are the pinned SDL_audiotypecvt.c scalar bit tricks.
//
// Regenerate: node gen-expected.mjs > expected.stdout
'use strict';

const MATRIX = [[[1],[1,1],[1,1,0],[1,1,0,0],[1,1,0,0,0],[1,1,0,0,0,0],[1,1,0,0,0,0,0],[1,1,0,0,0,0,0,0]],[[0.5,0.5],[1,0,0,1],[1,0,0,1,0,0],[1,0,0,1,0,0,0,0],[1,0,0,1,0,0,0,0,0,0],[1,0,0,1,0,0,0,0,0,0,0,0],[1,0,0,1,0,0,0,0,0,0,0,0,0,0],[1,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0]],[[0.333333343,0.333333343,0.333333343],[0.800000012,0,0.200000003,0,0.800000012,0.200000003],[1,0,0,0,1,0,0,0,1],[0.888888896,0,0.111111112,0,0.888888896,0.111111112,0,0,0.111111112,0,0,0.111111112],[1,0,0,0,1,0,0,0,1,0,0,0,0,0,0],[1,0,0,0,1,0,0,0,0,0,0,1,0,0,0,0,0,0],[1,0,0,0,1,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0],[1,0,0,0,1,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0]],[[0.25,0.25,0.25,0.25],[0.421000004,0,0.358999997,0.219999999,0,0.421000004,0.219999999,0.358999997],[0.421000004,0,0.358999997,0.219999999,0,0.421000004,0.219999999,0.358999997,0,0,0,0],[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],[1,0,0,0,0,1,0,0,0,0,0,0,0,0,1,0,0,0,0,1],[1,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,1],[0.939999998,0,0,0,0,0.939999998,0,0,0,0,0,0,0,0,0,0,0,0,0.5,0.5,0,0,0.796000004,0,0,0,0,0.796000004],[1,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,1,0,0,0,0,0,0,0,0]],[[0.200000003,0.200000003,0.200000003,0.200000003,0.200000003],[0.374222219,0,0.111111112,0.319111109,0.195555553,0,0.374222219,0.111111112,0.195555553,0.319111109],[0.421000004,0,0,0.358999997,0.219999999,0,0.421000004,0,0.219999999,0.358999997,0,0,1,0,0],[0.941176474,0,0.05882353,0,0,0,0.941176474,0.05882353,0,0,0,0,0.05882353,0.941176474,0,0,0,0.05882353,0,0.941176474],[1,0,0,0,0,0,1,0,0,0,0,0,1,0,0,0,0,0,1,0,0,0,0,0,1],[1,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,1,0,0,0,0,0,1],[0.939999998,0,0,0,0,0,0.939999998,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0.5,0.5,0,0,0,0.796000004,0,0,0,0,0,0.796000004],[1,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0,1,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0]],[[0.166666672,0.166666672,0.166666672,0.166666672,0.166666672,0.166666672],[0.294545442,0,0.208181813,0.090909094,0.25181818,0.154545456,0,0.294545442,0.208181813,0.090909094,0.154545456,0.25181818],[0.324000001,0,0.229000002,0,0.27700001,0.170000002,0,0.324000001,0.229000002,0,0.170000002,0.27700001,0,0,0,1,0,0],[0.558095276,0,0.394285709,0.047619049,0,0,0,0.558095276,0.394285709,0.047619049,0,0,0,0,0,0.047619049,0.558095276,0,0,0,0,0.047619049,0,0.558095276],[0.586000025,0,0.414000005,0,0,0,0,0.586000025,0.414000005,0,0,0,0,0,0,1,0,0,0,0,0,0,0.586000025,0,0,0,0,0,0,0.586000025],[1,0,0,0,0,0,0,1,0,0,0,0,0,0,1,0,0,0,0,0,0,1,0,0,0,0,0,0,1,0,0,0,0,0,0,1],[0.939999998,0,0,0,0,0,0,0.939999998,0,0,0,0,0,0,0.939999998,0,0,0,0,0,0,1,0,0,0,0,0,0,0.5,0.5,0,0,0,0,0.796000004,0,0,0,0,0,0,0.796000004],[1,0,0,0,0,0,0,1,0,0,0,0,0,0,1,0,0,0,0,0,0,1,0,0,0,0,0,0,1,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0,0,0,0]],[[0.143142849,0.143142849,0.143142849,0.142857149,0.143142849,0.143142849,0.143142849],[0.247384623,0,0.174461529,0.07692308,0.174461529,0.226153851,0.100615382,0,0.247384623,0.174461529,0.07692308,0.174461529,0.100615382,0.226153851],[0.268000007,0,0.188999996,0,0.188999996,0.245000005,0.108999997,0,0.268000007,0.188999996,0,0.188999996,0.108999997,0.245000005,0,0,0,1,0,0,0],[0.463679999,0,0.327360004,0.040000003,0,0.168960005,0,0,0.463679999,0.327360004,0.040000003,0,0,0.168960005,0,0,0,0.040000003,0.327360004,0.431039989,0,0,0,0,0.040000003,0.327360004,0,0.431039989],[0.48300001,0,0.340999991,0,0,0.175999999,0,0,0.48300001,0.340999991,0,0,0,0.175999999,0,0,0,1,0,0,0,0,0,0,0,0.340999991,0.449000001,0,0,0,0,0,0.340999991,0,0.449000001],[0.611000001,0,0,0,0,0.223000005,0,0,0.611000001,0,0,0,0,0.223000005,0,0,0.611000001,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0.432000011,0.568000019,0,0,0,0,0,0.432000011,0,0.568000019],[1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,1],[1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0.707000017,0,0,0,0,0,0,0.707000017,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,1]],[[0.125125006,0.125125006,0.125125006,0.125,0.125125006,0.125125006,0.125125006,0.125125006],[0.211866662,0,0.150266662,0.06666667,0.181066677,0.111066669,0.194133341,0.085866667,0,0.211866662,0.150266662,0.06666667,0.111066669,0.181066677,0.085866667,0.194133341],[0.226999998,0,0.160999998,0,0.194000006,0.119000003,0.208000004,0.092,0,0.226999998,0.160999998,0,0.119000003,0.194000006,0.092,0.208000004,0,0,0,1,0,0,0,0],[0.466344833,0,0.329241365,0.034482758,0,0,0.169931039,0,0,0.466344833,0.329241365,0.034482758,0,0,0,0.169931039,0,0,0,0.034482758,0.466344833,0,0.433517247,0,0,0,0,0.034482758,0,0.466344833,0,0.433517247],[0.48300001,0,0.340999991,0,0,0,0.175999999,0,0,0.48300001,0.340999991,0,0,0,0,0.175999999,0,0,0,1,0,0,0,0,0,0,0,0,0.48300001,0,0.449000001,0,0,0,0,0,0,0.48300001,0,0.449000001],[0.518000007,0,0,0,0,0,0.188999996,0,0,0.518000007,0,0,0,0,0,0.188999996,0,0,0.518000007,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0.518000007,0,0.481999993,0,0,0,0,0,0,0.518000007,0,0.481999993],[0.541000009,0,0,0,0,0,0,0,0,0.541000009,0,0,0,0,0,0,0,0,0.541000009,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0.287999988,0.287999988,0,0,0,0,0,0,0.458999991,0,0.541000009,0,0,0,0,0,0,0.458999991,0,0.541000009],[1,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0,0,1]]];

const U8 = 0x0008, S8 = 0x8008, S16 = 0x8010, S32 = 0x8020, F32 = 0x8120;
const FMTS = [U8, S8, S16, S32, F32];
const RATES = [[22050, 48000], [48000, 22050], [44100, 44100]];
const NFRAMES = 17;
const fr = Math.fround;

function fmtBytes(f) { return (f === U8 || f === S8) ? 1 : f === S16 ? 2 : 4; }
function pat(f, c, sf) { return ((f * 31 + c * 17 + sf * 13) % 255) - 127; }

const dvbuf = new DataView(new ArrayBuffer(8));
function bitsOf(f) { dvbuf.setFloat32(0, f, true); return dvbuf.getUint32(0, true); }
function floatOf(b) { dvbuf.setUint32(0, b >>> 0, true); return dvbuf.getFloat32(0, true); }
const signmask = (x) => (0 - ((x >>> 31))) >>> 0;

function decode(dv, off, fmt) {
  switch (fmt) {
  case F32: return dv.getFloat32(off, true);
  case S32: return fr(dv.getInt32(off, true) * fr(0.0000000004656612873077392578125));
  case S16: return fr(dv.getInt16(off, true) * fr(0.000030517578125));
  case S8:  return fr(dv.getInt8(off) * fr(0.0078125));
  default:  return fr((dv.getUint8(off) - 128) * fr(0.0078125));
  }
}

function encode(dv, off, fmt, v) {
  let x, y, z;
  switch (fmt) {
  case F32: dv.setFloat32(off, v, true); return;
  case S32:
    x = bitsOf(v);
    y = (x + 0x0F800000) >>> 0;
    z = (y - 0xCF000000) >>> 0;
    z = (z & signmask((y ^ z) >>> 0)) >>> 0;
    x = (y - z) >>> 0;
    dv.setInt32(off, (Math.trunc(floatOf(x)) ^ (signmask(z) | 0)) | 0, true);
    return;
  case S16:
    x = bitsOf(fr(v + 384.0));
    y = (x - 0x43C00000) >>> 0;
    z = (0x7FFF - ((y ^ signmask(y)) >>> 0)) >>> 0;
    y = (y ^ (z & signmask(z))) >>> 0;
    dv.setUint16(off, y & 0xFFFF, true);
    return;
  case S8:
    x = bitsOf(fr(v + 98304.0));
    y = (x - 0x47C00000) >>> 0;
    z = (0x7F - ((y ^ signmask(y)) >>> 0)) >>> 0;
    y = (y ^ (z & signmask(z))) >>> 0;
    dv.setUint8(off, y & 0xFF);
    return;
  default: // U8
    x = bitsOf(fr(v + 98304.0));
    y = (x - 0x47C00000) >>> 0;
    z = (0x7F - ((y ^ signmask(y)) >>> 0)) >>> 0;
    y = (((y ^ 0x80) >>> 0) ^ (z & signmask(z))) >>> 0;
    dv.setUint8(off, y & 0xFF);
    return;
  }
}

// one frame through the pinned default channel matrix, ascending source
// order, skipping zero coefficients — fround at every multiply and add
function chcvt(from, to, input) {
  if (from === to) return input;
  const k = MATRIX[from - 1][to - 1];
  const out = new Array(to);
  for (let d = 0; d < to; d++) {
    let acc = 0;
    for (let s = 0; s < from; s++) {
      const c = fr(k[d * from + s]);
      if (c === 0) continue;
      acc = fr(acc + fr(input[s] * c));
    }
    out[d] = fr(acc);
  }
  return out;
}

function fillSrc(fmt, ch, sfi) {
  const buf = new ArrayBuffer(NFRAMES * ch * fmtBytes(fmt));
  const dv = new DataView(buf);
  for (let f = 0; f < NFRAMES; f++) {
    for (let c = 0; c < ch; c++) {
      const p = pat(f, c, sfi);
      const off = (f * ch + c) * fmtBytes(fmt);
      if (fmt === U8) dv.setUint8(off, (p + 128) & 0xFF);
      else if (fmt === S8) dv.setInt8(off, p);
      else if (fmt === S16) dv.setInt16(off, (p * 257) | 0, true);
      else if (fmt === S32) dv.setInt32(off, (p * 16843009) | 0, true);
      else dv.setFloat32(off, fr(p / fr(127.0)), true);
    }
  }
  return dv;
}

// convert a whole flushed epoch: N source frames, sspec -> dspec
function convert(sdv, N, sfmt, sch, sf, dfmt, dch, df) {
  const total = Math.ceil((N * df) / sf);
  const dfb = fmtBytes(dfmt) * dch;
  const out = new DataView(new ArrayBuffer(total * dfb));
  if (sfmt === dfmt && sch === dch && sf === df) {
    // pass-through fast path, byte-identical
    for (let i = 0; i < N * dfb; i++) out.setUint8(i, sdv.getUint8(i));
    return out;
  }
  const sfb = fmtBytes(sfmt) * sch;
  const frameAt = (idx) => {
    if (idx > N - 1) idx = N - 1;
    const f = new Array(sch);
    for (let c = 0; c < sch; c++) f[c] = decode(sdv, idx * sfb + c * fmtBytes(sfmt), sfmt);
    return f;
  };
  for (let k = 0; k < total; k++) {
    const num = k * sf;
    const i = Math.floor(num / df), r = num % df;
    let a = chcvt(sch, dch, frameAt(i));
    if (r !== 0) {
      const b = chcvt(sch, dch, frameAt(i + 1));
      const t = fr(r / df);
      const m = new Array(dch);
      for (let c = 0; c < dch; c++) m[c] = fr(a[c] + fr(fr(b[c] - a[c]) * t));
      a = m;
    }
    for (let c = 0; c < dch; c++) encode(out, k * dfb + c * fmtBytes(dfmt), dfmt, a[c]);
  }
  return out;
}

function fnv(h, dv, n) {
  for (let i = 0; i < n; i++) { h = (h ^ dv.getUint8(i)) >>> 0; h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}
const hex = (h) => (h >>> 0).toString(16).padStart(8, '0');

const lines = [];

// leg 1: the sweep
let grand = 2166136261 >>> 0;
for (let sc = 1; sc <= 8; sc++) {
  for (let dc = 1; dc <= 8; dc++) {
    let pair = 2166136261 >>> 0;
    for (let si = 0; si < 5; si++) {
      for (let di = 0; di < 5; di++) {
        for (let ri = 0; ri < 3; ri++) {
          const sdv = fillSrc(FMTS[si], sc, si);
          const out = convert(sdv, NFRAMES, FMTS[si], sc, RATES[ri][0], FMTS[di], dc, RATES[ri][1]);
          pair = fnv(pair, out, out.byteLength);
          const frames = out.byteLength / (dc * fmtBytes(FMTS[di]));
          const nb = new DataView(new ArrayBuffer(4));
          nb.setUint8(0, frames & 0xFF); nb.setUint8(1, (frames >> 8) & 0xFF);
          pair = fnv(pair, nb, 4);
        }
      }
    }
    lines.push(`ch ${sc}->${dc} ${hex(pair)}`);
    const pb = new DataView(new ArrayBuffer(4));
    pb.setUint32(0, pair, true);
    grand = fnv(grand, pb, 4);
  }
}
lines.push(`total ${hex(grand)}`);

// leg 2: chunk invariance — MATCH with the flushed byte total
{
  const total = Math.ceil((NFRAMES * 48000) / 22050) * 4;   // F32 mono out
  lines.push(`chunk invariance MATCH (${total} bytes)`);
}

// leg 3: saturation — through the same encoders
{
  const loud = [2.0, -2.0, 1.0, -1.0];
  for (const [name, fmt] of [['U8', U8], ['S8', S8], ['S16', S16], ['S32', S32]]) {
    const w = fmtBytes(fmt);
    const dv = new DataView(new ArrayBuffer(4 * w));
    for (let i = 0; i < 4; i++) encode(dv, i * w, fmt, fr(loud[i]));
    const vals = [];
    for (let i = 0; i < 4; i++) {
      vals.push(fmt === U8 ? dv.getUint8(i) : fmt === S8 ? dv.getInt8(i) :
                fmt === S16 ? dv.getInt16(i * 2, true) : dv.getInt32(i * 4, true));
    }
    lines.push(`sat ${name} ${4 * w}: ${vals.join(' ')}`);
  }
}

// leg 4: upsample tail
{
  const sdv = new DataView(new ArrayBuffer(6));
  sdv.setInt16(0, 300, true); sdv.setInt16(2, 600, true); sdv.setInt16(4, 900, true);
  const N = 3, sf = 16000, df = 48000;
  const unflushed = (Math.floor(((N - 1) * df) / sf) + 1) * 2;
  const flushedTotal = Math.ceil((N * df) / sf);
  lines.push(`tail avail unflushed ${unflushed}`);
  lines.push(`tail avail flushed ${flushedTotal * 2}`);
  const out = convert(sdv, N, S16, 1, sf, S16, 1, df);
  const vals = [];
  for (let k = 0; k < flushedTotal; k++) vals.push(out.getInt16(k * 2, true));
  lines.push(`tail got ${flushedTotal * 2}: ${vals.join(' ')}`);
}

process.stdout.write(lines.join('\n') + '\n');
