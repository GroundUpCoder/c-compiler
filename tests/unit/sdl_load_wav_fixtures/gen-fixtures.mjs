#!/usr/bin/env node
// gen-fixtures.mjs — deterministic WAV corpus generator for #529-B (#723).
//
// Regenerates every committed .wav fixture in this directory (except the two
// upstream imports, sample.wav and sword.wav, which come verbatim from the
// pinned SDL tree — see upstream.json in ../sdl_load_wav/). Byte-deterministic:
// payload bytes come from a per-fixture seeded LCG (seed = FNV-1a of the
// fixture name), so a re-run reproduces the corpus bit-exact. No RNG, no
// clock, no environment.
//
// The corpus covers the #529-B differential matrix (the superseding proposal,
// "#529-B complete SDL_LoadWAV"): every codec/width, mono/stereo (+3ch/4ch),
// extensible headers, odd padded chunks, unknown chunks, fmt/data ordering,
// valid/invalid/lying fact chunks, truncated RIFF/chunk/data, malformed MS and
// IMA block headers / coefficients / sample counts, zero-length data, lying
// maximum lengths, invalid block alignment / rate / channels, and the frozen
// 10000-chunk-count limit. ADPCM payloads are arbitrary seeded bytes on
// purpose: any nibble stream is valid ADPCM input, and the pinned upstream
// oracle (not an encoder) defines the expected decode — see gen-manifest.mjs.
//
//   node tests/unit/sdl_load_wav_fixtures/gen-fixtures.mjs          # fixtures
//   node tests/unit/sdl_load_wav_fixtures/gen-fixtures.mjs --perf D # perf wavs
//                                                                   # into dir D
//                                                                   # (not committed)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---- deterministic bytes ---------------------------------------------------

function fnv1a(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h = (h ^ str.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function lcg(seed) {
  let s = seed >>> 0;
  if (s === 0) s = 0x9e3779b9;
  return () => {
    // Numerical Recipes LCG; take the high byte.
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return (s >>> 24) & 0xff;
  };
}

// ---- little-endian byte builders --------------------------------------------

const u8 = (v) => Buffer.from([v & 0xff]);
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v >>> 0, 0); return b; };
const s16 = (v) => { const b = Buffer.alloc(2); b.writeInt16LE(v | 0, 0); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); return b; };
const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v, 0); return b; };
const tag4 = (s) => Buffer.from(s, 'latin1');
const cat = (...parts) => Buffer.concat(parts);

function randBytes(name, n) {
  const next = lcg(fnv1a(name));
  const b = Buffer.alloc(n);
  for (let i = 0; i < n; i++) b[i] = next();
  return b;
}

// A RIFF chunk: fourcc + u32 length + payload (+ pad byte when odd, unless
// suppressed — RIFF's 2-byte alignment rule; the loader must skip the pad).
function chunk(fourcc, payload, { pad = true, lenOverride = null } = {}) {
  const parts = [tag4(fourcc), u32(lenOverride != null ? lenOverride : payload.length), payload];
  if (pad && (payload.length & 1)) parts.push(u8(0));
  return cat(...parts);
}

// The standard fmt payload. ext == null → 16-byte fmt (no cbSize field);
// ext === Buffer → cbSize + that buffer (pass Buffer.alloc(0) for cbSize=0).
function fmtPayload({ tag, channels, freq, blockalign, bits, ext = null, extSizeOverride = null }) {
  const byterate = Math.min(0xffffffff, freq * blockalign) >>> 0; // advisory field; decoders ignore it
  const parts = [u16(tag), u16(channels), u32(freq), u32(byterate), u16(blockalign), u16(bits)];
  if (ext !== null) {
    parts.push(u16(extSizeOverride != null ? extSizeOverride : ext.length));
    parts.push(ext);
  }
  return cat(...parts);
}

// WAVEFORMATEXTENSIBLE ext block: validbits u16 + channelmask u32 + GUID.
function extensibleExt({ validbits, mask, guidTag = null, guidRaw = null }) {
  const guid = guidRaw != null ? guidRaw
    : Buffer.from([guidTag & 0xff, (guidTag >> 8) & 0xff, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113]);
  return cat(u16(validbits), u32(mask), guid);
}

// The MS ADPCM fmt ext: wSamplesPerBlock + wNumCoef + coeff pairs.
const MS_PRESETS = [256, 0, 512, -256, 0, 0, 192, 64, 240, 0, 460, -208, 392, -232];
function msExt({ spb, coeffs = MS_PRESETS }) {
  const parts = [u16(spb), u16(coeffs.length / 2)];
  for (const c of coeffs) parts.push(s16(c));
  return cat(...parts);
}

// One MS ADPCM data block: predictors, deltas, sample1s, sample2s, nibbles.
function msBlock(name, { channels, blockalign, predictors = null, deltas = null }) {
  const next = lcg(fnv1a(name + ':ms'));
  const parts = [];
  for (let c = 0; c < channels; c++) parts.push(u8(predictors ? predictors[c] : c % 7));
  for (let c = 0; c < channels; c++) parts.push(u16(deltas ? deltas[c] : 16 + (next() % 480)));
  for (let c = 0; c < channels; c++) parts.push(s16(((next() << 8) | next()) - 32768));
  for (let c = 0; c < channels; c++) parts.push(s16(((next() << 8) | next()) - 32768));
  const head = cat(...parts);
  const body = Buffer.alloc(blockalign - head.length);
  for (let i = 0; i < body.length; i++) body[i] = next();
  return cat(head, body);
}

// One IMA ADPCM data block: per-channel {sample s16, stepindex u8, 0} + nibbles.
function imaBlock(name, { channels, blockalign }) {
  const next = lcg(fnv1a(name + ':ima'));
  const parts = [];
  for (let c = 0; c < channels; c++) {
    parts.push(s16(((next() << 8) | next()) - 32768));
    parts.push(u8(next() % 89));
    parts.push(u8(0));
  }
  const head = cat(...parts);
  const body = Buffer.alloc(blockalign - head.length);
  for (let i = 0; i < body.length; i++) body[i] = next();
  return cat(head, body);
}

// Assemble "RIFF" + len + "WAVE" + chunks. riffLen: 'auto' (filesize-8),
// number (lie), or 'zero'.
function riff(chunks, { riffLen = 'auto' } = {}) {
  const body = cat(tag4('WAVE'), ...chunks);
  const len = riffLen === 'auto' ? body.length : (riffLen === 'zero' ? 0 : riffLen);
  return cat(tag4('RIFF'), u32(len), body);
}

// ---- the corpus --------------------------------------------------------------

const fixtures = new Map();
function fix(name, buf) {
  if (fixtures.has(name)) throw new Error('duplicate fixture ' + name);
  fixtures.set(name, buf);
}

function pcmFixture(name, { tag, channels, freq, bits, frames, ext = null, extSizeOverride = null }) {
  const blockalign = channels * (bits >> 3);
  const data = randBytes(name, frames * blockalign);
  fix(name, riff([
    chunk('fmt ', fmtPayload({ tag, channels, freq, blockalign, bits, ext, extSizeOverride })),
    chunk('data', data),
  ]));
}

const PCM = 0x0001, MS = 0x0002, FLOAT = 0x0003, ALAW = 0x0006, MULAW = 0x0007, IMA = 0x0011, EXT = 0xfffe;

// -- every codec/width, mono/stereo (frames deliberately odd where it makes the
//    data chunk length odd, exercising the RIFF pad rule at EOF) --
pcmFixture('pcm_u8_mono', { tag: PCM, channels: 1, freq: 8000, bits: 8, frames: 37 });
pcmFixture('pcm_u8_stereo', { tag: PCM, channels: 2, freq: 11025, bits: 8, frames: 24 });
pcmFixture('pcm_s16_mono', { tag: PCM, channels: 1, freq: 44100, bits: 16, frames: 33 });
pcmFixture('pcm_s16_stereo', { tag: PCM, channels: 2, freq: 22050, bits: 16, frames: 25 });
pcmFixture('pcm_s16_3ch', { tag: PCM, channels: 3, freq: 16000, bits: 16, frames: 19 });
pcmFixture('pcm_s24_mono', { tag: PCM, channels: 1, freq: 48000, bits: 24, frames: 21 });
pcmFixture('pcm_s24_stereo', { tag: PCM, channels: 2, freq: 44100, bits: 24, frames: 17 });
pcmFixture('pcm_s32_mono', { tag: PCM, channels: 1, freq: 96000, bits: 32, frames: 15 });
pcmFixture('pcm_s32_stereo', { tag: PCM, channels: 2, freq: 48000, bits: 32, frames: 13 });
// float32: real float payloads (values in [-1,1] plus a few out-of-range).
{
  for (const [name, channels, freq, frames] of [['float32_mono', 1, 44100, 29], ['float32_stereo', 2, 48000, 18]]) {
    const next = lcg(fnv1a(name));
    const vals = [];
    for (let i = 0; i < frames * channels; i++) {
      const r = ((next() << 8) | next()) / 32768 - 1; // [-1, 1)
      vals.push(f32(i % 11 === 10 ? r * 2.5 : r));    // sprinkle out-of-range
    }
    fix(name, riff([
      chunk('fmt ', fmtPayload({ tag: FLOAT, channels, freq, blockalign: channels * 4, bits: 32 })),
      chunk('data', cat(...vals)),
    ]));
  }
}
pcmFixture('alaw_mono', { tag: ALAW, channels: 1, freq: 8000, bits: 8, frames: 41 });
pcmFixture('alaw_stereo', { tag: ALAW, channels: 2, freq: 8000, bits: 8, frames: 23 });
pcmFixture('mulaw_mono', { tag: MULAW, channels: 1, freq: 8000, bits: 8, frames: 39 });
pcmFixture('mulaw_stereo', { tag: MULAW, channels: 2, freq: 11025, bits: 8, frames: 22 });

// -- MS ADPCM. mono blockalign 32 (spb = (32-7)*2+2 = 52), stereo 64. --
function msFixture(name, { channels, freq, blockalign, spb, blocks, coeffs = MS_PRESETS, lastBlockBytes = null, predictors = null }) {
  const parts = [];
  for (let b = 0; b < blocks; b++) parts.push(msBlock(name + ':' + b, { channels, blockalign, predictors }));
  let data = cat(...parts);
  if (lastBlockBytes != null) data = data.subarray(0, (blocks - 1) * blockalign + lastBlockBytes);
  fix(name, riff([
    chunk('fmt ', fmtPayload({ tag: MS, channels, freq, blockalign, bits: 4, ext: msExt({ spb, coeffs }) })),
    chunk('data', data),
  ]));
}
msFixture('msadpcm_mono', { channels: 1, freq: 22050, blockalign: 32, spb: 52, blocks: 3 });
msFixture('msadpcm_stereo', { channels: 2, freq: 44100, blockalign: 64, spb: 52, blocks: 2 });
msFixture('msadpcm_custom_coeffs', {
  channels: 1, freq: 11025, blockalign: 32, spb: 52, blocks: 2,
  coeffs: [...MS_PRESETS, 100, -50], predictors: [7],   // predictor 7 = the custom pair
});
msFixture('ms_trunc_block', { channels: 1, freq: 22050, blockalign: 32, spb: 52, blocks: 3, lastBlockBytes: 19 });
msFixture('ms_trunc_header', { channels: 1, freq: 22050, blockalign: 32, spb: 52, blocks: 3, lastBlockBytes: 4 });
msFixture('ms_badcoeffindex', { channels: 1, freq: 22050, blockalign: 32, spb: 52, blocks: 1, predictors: [200] });

// -- IMA ADPCM. mono blockalign 36 (spb = (36-4)*2+1 = 65), stereo 72, 4ch 144. --
function imaFixture(name, { channels, freq, blockalign, spb, blocks, lastBlockBytes = null, ext = undefined }) {
  const parts = [];
  for (let b = 0; b < blocks; b++) parts.push(imaBlock(name + ':' + b, { channels, blockalign }));
  let data = cat(...parts);
  if (lastBlockBytes != null) data = data.subarray(0, (blocks - 1) * blockalign + lastBlockBytes);
  const fmtExt = ext !== undefined ? ext : u16(spb);
  fix(name, riff([
    chunk('fmt ', fmtPayload({ tag: ext !== undefined ? EXT : IMA, channels, freq, blockalign, bits: 4, ext: fmtExt })),
    chunk('data', data),
  ]));
}
imaFixture('imaadpcm_mono', { channels: 1, freq: 22050, blockalign: 36, spb: 65, blocks: 3 });
imaFixture('imaadpcm_stereo', { channels: 2, freq: 44100, blockalign: 72, spb: 65, blocks: 2 });
imaFixture('imaadpcm_4ch', { channels: 4, freq: 16000, blockalign: 144, spb: 65, blocks: 2 });
imaFixture('ima_trunc_block', { channels: 1, freq: 22050, blockalign: 36, spb: 65, blocks: 3, lastBlockBytes: 21 });
// extensible IMA: samplesperblock rides the validbits field (upstream reads it there).
imaFixture('ext_imaadpcm_mono', {
  channels: 1, freq: 22050, blockalign: 36, spb: 65, blocks: 2,
  ext: extensibleExt({ validbits: 65, mask: 0x4, guidTag: IMA }),
});

// -- extensible headers over simple codecs --
pcmFixture('ext_pcm16_stereo', {
  tag: EXT, channels: 2, freq: 44100, bits: 16, frames: 21,
  ext: extensibleExt({ validbits: 16, mask: 0x3, guidTag: PCM }),
});
pcmFixture('ext_float32_mono', {
  tag: EXT, channels: 1, freq: 48000, bits: 32, frames: 17,
  ext: extensibleExt({ validbits: 32, mask: 0x4, guidTag: FLOAT }),
});
pcmFixture('ext_alaw_mono', {
  tag: EXT, channels: 1, freq: 8000, bits: 8, frames: 27,
  ext: extensibleExt({ validbits: 8, mask: 0x4, guidTag: ALAW }),
});

// -- container shapes --
{
  // WAVE form with no RIFF wrapper: the file BEGINS with a chunk whose fourcc
  // is WAVE (upstream treats it as a headerless form, length unknown).
  const fmtc = chunk('fmt ', fmtPayload({ tag: PCM, channels: 1, freq: 8000, bits: 8 }));
  const datac = chunk('data', randBytes('wave_form_only', 19));
  fix('wave_form_only', cat(tag4('WAVE'), u32(0), fmtc, datac));
}
{
  const mk = (name, opts, pre = [], post = []) => fix(name, riff([
    ...pre,
    chunk('fmt ', fmtPayload({ tag: PCM, channels: 1, freq: 22050, bits: 16 })),
    chunk('data', randBytes(name, 2 * 23)),
    ...post,
  ], opts));
  mk('riff_size_zero', { riffLen: 'zero' });
  mk('riff_size_lying_large', { riffLen: 0xfffffff0 });
  mk('junk_odd_chunk', {}, [chunk('JUNK', randBytes('junk_odd_chunk:junk', 13))]);
  mk('unknown_chunks', {}, [
    chunk('cue ', randBytes('unknown_chunks:cue', 12)),
    chunk('smpl', randBytes('unknown_chunks:smpl', 8)),
    chunk('bext', randBytes('unknown_chunks:bext', 22)),
  ]);
  mk('trailing_garbage', {}, [], [chunk('LIST', randBytes('trailing_garbage:list', 10))]);
}
{
  // odd-length data chunk with a chunk after it (the pad byte must be skipped
  // to find it; under frozen defaults the walk breaks at data anyway — the
  // oracle pins whichever behavior upstream has).
  fix('data_odd_len', riff([
    chunk('fmt ', fmtPayload({ tag: PCM, channels: 1, freq: 8000, bits: 8 })),
    chunk('data', randBytes('data_odd_len', 15)),
    chunk('fact', u32(15)),
  ]));
}

// -- fact chunks (frozen FactNoHint: never truncates; oracle confirms) --
function factFixture(name, factPayload, { after = false, frames = 20 } = {}) {
  const fmtc = chunk('fmt ', fmtPayload({ tag: PCM, channels: 1, freq: 16000, bits: 16 }));
  const datac = chunk('data', randBytes(name, 2 * frames));
  const factc = chunk('fact', factPayload);
  fix(name, riff(after ? [fmtc, datac, factc] : [fmtc, factc, datac]));
}
factFixture('fact_valid_pcm', u32(20));
factFixture('fact_lying_large', u32(1000000));
factFixture('fact_zero', u32(0));
factFixture('fact_short', u16(3));           // length 2 < 4 → invalid fact
factFixture('fact_after_data', u32(20), { after: true });

// -- duplicate chunks: first one wins --
{
  const d1 = randBytes('multiple_fmt:1', 2 * 11);
  fix('multiple_fmt', riff([
    chunk('fmt ', fmtPayload({ tag: PCM, channels: 1, freq: 8000, bits: 16 })),
    chunk('fmt ', fmtPayload({ tag: PCM, channels: 2, freq: 44100, bits: 8 })),
    chunk('data', d1),
  ]));
  fix('multiple_data', riff([
    chunk('fmt ', fmtPayload({ tag: PCM, channels: 1, freq: 8000, bits: 16 })),
    chunk('data', randBytes('multiple_data:1', 2 * 9)),
    chunk('data', randBytes('multiple_data:2', 2 * 30)),
  ]));
  fix('multiple_fact', riff([
    chunk('fmt ', fmtPayload({ tag: PCM, channels: 1, freq: 8000, bits: 16 })),
    chunk('fact', u32(9)),
    chunk('fact', u32(7)),
    chunk('data', randBytes('multiple_fact:1', 2 * 9)),
  ]));
}

// -- zero-length data per codec family (success, NULL buffer, len 0) --
for (const [name, tag, bits, blockalign, ext] of [
  ['pcm_zero_data', PCM, 16, 2, null],
  ['law_zero_data', MULAW, 8, 1, null],
  ['ms_zero_data', MS, 4, 32, msExt({ spb: 52 })],
  ['ima_zero_data', IMA, 4, 36, u16(65)],
]) {
  fix(name, riff([
    chunk('fmt ', fmtPayload({ tag, channels: 1, freq: 8000, blockalign, bits, ext })),
    chunk('data', Buffer.alloc(0)),
  ]));
}

// -- truncation: data chunk length lies past EOF (loader clamps to file size) --
{
  const whole = riff([
    chunk('fmt ', fmtPayload({ tag: PCM, channels: 2, freq: 22050, bits: 16 })),
    chunk('data', randBytes('pcm_s16_trunc', 100), { lenOverride: 100 }),
  ]);
  fix('pcm_s16_trunc', whole.subarray(0, whole.length - 63)); // mid-frame cut
}

{
  // explicit-blockalign mid-frame cut: 4-byte frames, cut leaves 4n+1 bytes —
  // the partial frame must be dropped by the blockalign division.
  const whole = riff([
    chunk('fmt ', fmtPayload({ tag: PCM, channels: 2, freq: 22050, blockalign: 4, bits: 16 })),
    chunk('data', randBytes('pcm_s16_trunc_ba', 96), { lenOverride: 96 }),
  ]);
  fix('pcm_s16_trunc_ba', whole.subarray(0, whole.length - 59));
}
{
  // a CORRECT fact chunk on compressed audio (the realistic encoder shape) —
  // frozen FactNoHint ignores it; the oracle pins that it stays ignored.
  const blocks = cat(imaBlock('ima_fact_valid:0', { channels: 1, blockalign: 36 }),
                     imaBlock('ima_fact_valid:1', { channels: 1, blockalign: 36 }));
  fix('ima_fact_valid', riff([
    chunk('fmt ', fmtPayload({ tag: IMA, channels: 1, freq: 22050, blockalign: 36, bits: 4, ext: u16(65) })),
    chunk('fact', u32(130)),
    chunk('data', blocks),
  ]));
}

// -- failure shapes --
fix('not_riff', randBytes('not_riff', 64));
fix('empty_file', Buffer.alloc(0));
fix('header_only', cat(tag4('RIFF'), u32(4), tag4('WAVE')));
{
  const body = cat(tag4('AVI '), chunk('fmt ', fmtPayload({ tag: PCM, channels: 1, freq: 8000, bits: 8 })));
  fix('riff_not_wave', cat(tag4('RIFF'), u32(body.length), body));
}
fix('no_fmt', riff([chunk('data', randBytes('no_fmt', 16))]));
fix('no_data', riff([chunk('fmt ', fmtPayload({ tag: PCM, channels: 1, freq: 8000, bits: 8 }))]));
fix('data_before_fmt', riff([
  chunk('data', randBytes('data_before_fmt', 16)),
  chunk('fmt ', fmtPayload({ tag: PCM, channels: 1, freq: 8000, bits: 8 })),
]));
{
  const full = fmtPayload({ tag: PCM, channels: 1, freq: 8000, bits: 16 });
  fix('fmt_too_short_len', riff([chunk('fmt ', full.subarray(0, 12)), chunk('data', randBytes('fmt_too_short_len', 8))]));
  fix('fmt_missing_bps', riff([chunk('fmt ', full.subarray(0, 14)), chunk('data', randBytes('fmt_missing_bps', 8))]));
}
const badFmt = (name, opts, frames = 8) => fix(name, riff([
  chunk('fmt ', fmtPayload(opts)),
  chunk('data', randBytes(name, frames * Math.max(1, opts.blockalign || (opts.channels * (opts.bits >> 3))))),
]));
badFmt('channels_zero', { tag: PCM, channels: 0, freq: 8000, blockalign: 1, bits: 8 });
badFmt('freq_zero', { tag: PCM, channels: 1, freq: 0, blockalign: 1, bits: 8 });
badFmt('freq_over_intmax', { tag: PCM, channels: 1, freq: 0x80000000, blockalign: 1, bits: 8 });
badFmt('pcm_bits12', { tag: PCM, channels: 1, freq: 8000, blockalign: 2, bits: 12 });
badFmt('pcm_bits0', { tag: PCM, channels: 1, freq: 8000, blockalign: 1, bits: 0 });
badFmt('float64', { tag: FLOAT, channels: 1, freq: 8000, blockalign: 8, bits: 64 });
badFmt('law_bits16', { tag: ALAW, channels: 1, freq: 8000, blockalign: 2, bits: 16 });
badFmt('law_badalign', { tag: ALAW, channels: 2, freq: 8000, blockalign: 3, bits: 8 });
badFmt('pcm_badalign', { tag: PCM, channels: 1, freq: 8000, blockalign: 3, bits: 16 });
badFmt('mpeg_code', { tag: 0x0050, freq: 8000, channels: 1, blockalign: 1, bits: 0 });
badFmt('mpeg3_code', { tag: 0x0055, freq: 8000, channels: 1, blockalign: 1, bits: 0 });
badFmt('unknown_tag', { tag: 0x1234, freq: 8000, channels: 1, blockalign: 2, bits: 16 });
badFmt('ext_unknown_guid', {
  tag: EXT, channels: 1, freq: 8000, blockalign: 2, bits: 16,
  ext: extensibleExt({ validbits: 16, mask: 0x4, guidRaw: randBytes('ext_unknown_guid:guid', 16) }),
});
badFmt('ext_too_small', {
  tag: EXT, channels: 1, freq: 8000, blockalign: 2, bits: 16,
  ext: cat(u16(16), u32(0x4), Buffer.alloc(12)),   // 18-byte ext, extsize says 18 < 22
});
badFmt('ms_ext_header', {
  tag: EXT, channels: 1, freq: 8000, blockalign: 32, bits: 4,
  ext: extensibleExt({ validbits: 52, mask: 0x4, guidTag: MS }),
});
badFmt('ms_bits8', { tag: MS, channels: 1, freq: 8000, blockalign: 32, bits: 8, ext: msExt({ spb: 52 }) });
badFmt('ms_align_small', { tag: MS, channels: 2, freq: 8000, blockalign: 8, bits: 4, ext: msExt({ spb: 2 }) });
badFmt('ms_hdr_short', { tag: MS, channels: 1, freq: 8000, blockalign: 32, bits: 4, ext: Buffer.alloc(0) });
badFmt('ms_coeff_missing', { tag: MS, channels: 1, freq: 8000, blockalign: 32, bits: 4, ext: msExt({ spb: 52, coeffs: MS_PRESETS.slice(0, 6) }) });
badFmt('ms_coeff_wrongpreset', { tag: MS, channels: 1, freq: 8000, blockalign: 32, bits: 4, ext: msExt({ spb: 52, coeffs: [300, ...MS_PRESETS.slice(1)] }) });
badFmt('ms_coeff_shortchunk', { tag: MS, channels: 1, freq: 8000, blockalign: 32, bits: 4, ext: cat(u16(52), u16(40), s16(256), s16(0)) });
badFmt('ms_extsize_small', { tag: MS, channels: 1, freq: 8000, blockalign: 32, bits: 4, ext: msExt({ spb: 52 }), extSizeOverride: 4 });
badFmt('ms_spb_one', { tag: MS, channels: 1, freq: 8000, blockalign: 32, bits: 4, ext: msExt({ spb: 1 }) });
badFmt('ms_spb_toobig', { tag: MS, channels: 1, freq: 8000, blockalign: 32, bits: 4, ext: msExt({ spb: 500 }) });
badFmt('ima_bits3', { tag: IMA, channels: 1, freq: 8000, blockalign: 36, bits: 3, ext: u16(65) });
badFmt('ima_bits8', { tag: IMA, channels: 1, freq: 8000, blockalign: 36, bits: 8, ext: u16(65) });
badFmt('ima_align_odd', { tag: IMA, channels: 1, freq: 8000, blockalign: 34, bits: 4, ext: u16(61) });
badFmt('ima_align_small', { tag: IMA, channels: 2, freq: 8000, blockalign: 4, bits: 4, ext: u16(1) });
badFmt('ima_spb_toobig', { tag: IMA, channels: 1, freq: 8000, blockalign: 36, bits: 4, ext: u16(500) });

// -- the frozen 10000-chunk limit: 10001 tiny junk chunks before fmt --
{
  const parts = [];
  for (let i = 0; i < 10001; i++) parts.push(chunk('JUNK', Buffer.alloc(0)));
  parts.push(chunk('fmt ', fmtPayload({ tag: PCM, channels: 1, freq: 8000, bits: 8 })));
  parts.push(chunk('data', randBytes('chunk_flood', 8)));
  fix('chunk_flood', riff(parts));
}

// ---- perf fixtures (NOT committed; --perf <outdir>) --------------------------

function perfCorpus(outdir) {
  const FRAMES = 220500; // 5 s at 44.1 kHz
  const mk = (name, buf) => fs.writeFileSync(path.join(outdir, name + '.wav'), buf);
  for (const [name, tag, bits] of [['perf_pcm16', PCM, 16], ['perf_pcm24', PCM, 24], ['perf_float32', FLOAT, 32]]) {
    const blockalign = 2 * (bits >> 3);
    mk(name, riff([
      chunk('fmt ', fmtPayload({ tag, channels: 2, freq: 44100, blockalign, bits })),
      chunk('data', randBytes(name, FRAMES * blockalign)),
    ]));
  }
  mk('perf_mulaw', riff([
    chunk('fmt ', fmtPayload({ tag: MULAW, channels: 2, freq: 44100, blockalign: 2, bits: 8 })),
    chunk('data', randBytes('perf_mulaw', FRAMES * 2)),
  ]));
  {
    const blocks = [];
    const blockalign = 512, spb = (blockalign - 7) * 2 + 2;
    const nblocks = Math.ceil(FRAMES / spb);
    for (let b = 0; b < nblocks; b++) blocks.push(msBlock('perf_ms:' + b, { channels: 1, blockalign }));
    mk('perf_msadpcm', riff([
      chunk('fmt ', fmtPayload({ tag: MS, channels: 1, freq: 44100, blockalign, bits: 4, ext: msExt({ spb }) })),
      chunk('data', cat(...blocks)),
    ]));
  }
  {
    const blocks = [];
    const blockalign = 512, spb = (blockalign - 4) * 2 + 1;
    const nblocks = Math.ceil(FRAMES / spb);
    for (let b = 0; b < nblocks; b++) blocks.push(imaBlock('perf_ima:' + b, { channels: 1, blockalign }));
    mk('perf_imaadpcm', riff([
      chunk('fmt ', fmtPayload({ tag: IMA, channels: 1, freq: 44100, blockalign, bits: 4, ext: u16(spb) })),
      chunk('data', cat(...blocks)),
    ]));
  }
  console.log('perf corpus written to ' + outdir);
}

// ---- main --------------------------------------------------------------------

const perfIx = process.argv.indexOf('--perf');
if (perfIx >= 0) {
  const outdir = process.argv[perfIx + 1];
  if (!outdir) { console.error('--perf needs an output dir'); process.exit(1); }
  fs.mkdirSync(outdir, { recursive: true });
  perfCorpus(outdir);
  process.exit(0);
}

let total = 0;
for (const [name, buf] of fixtures) {
  fs.writeFileSync(path.join(HERE, name + '.wav'), buf);
  total += buf.length;
}
console.log(`wrote ${fixtures.size} fixtures (${total} bytes) to ${HERE}`);
