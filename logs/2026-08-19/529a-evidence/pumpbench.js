'use strict';
// audioPump micro-bench: one 48k stereo S16 source ring, always full,
// pump 3840-frame blocks; report per-pump percentiles.
const path = process.argv[2];
const K = require(path);
const kernel = new K.Kernel({ createWorker: () => { throw new Error('no workers'); }, loadImage: () => null, onOutput: () => {}, onHalt: () => {}, log: () => {} });
const outInfo = kernel.audioInit({});
const octl = new Int32Array(outInfo.sab, 0, 4);
const RING = 256 * 1024;
const sab = new SharedArrayBuffer(16 + RING);
const ctl = new Int32Array(sab, 0, 4);
const dv = new DataView(sab, 16, RING);
for (let i = 0; i < RING / 2; i++) dv.setInt16(i * 2, (i * 7919) & 0x7fff, true);
kernel._audioStreams.set(1, {
  aid: 1, pid: 99, control: ctl, dv, cap: RING, freq: 48000, channels: 2,
  sampleBytes: 2, frameBytes: 4, decode: (d, o) => d.getInt16(o, true) / 32768,
  frac: 0, dying: false,
});
Atomics.store(ctl, 2, 1);   // playing
const N = 2000, lat = new Float64Array(N);
for (let it = 0; it < N; it++) {
  Atomics.store(ctl, 1, RING);            // queued: always full
  Atomics.store(ctl, 0, 0);               // wpos
  Atomics.store(octl, 1, 0);              // drain output
  const t0 = process.hrtime.bigint();
  const n = kernel.audioPump(3840);
  lat[it] = Number(process.hrtime.bigint() - t0) / 1000;
  if (n !== 3840) { console.error('short pump', n); process.exit(1); }
}
const s = Array.from(lat.slice(100)).sort((a, b) => a - b);
const q = (p) => s[Math.floor(s.length * p)].toFixed(1);
console.log(`${path}: pump 3840fr p50 ${q(0.5)}us p95 ${q(0.95)}us p99 ${q(0.99)}us`);
