#!/usr/bin/env node
// #790 — the browser compositor's shm upload cache (os/compositor.js
// makeShmUploader), driven in Node with a FAKE WebGPU device that records
// every createTexture / writeTexture / destroy. What is pinned:
//   - upload gated on the frame identity (gen, seq): same seq + same gen =
//     no upload; a new seq uploads; a fresh SAB of the SAME size with a new
//     generation is a NEW texture (the equal-size regeneration case);
//   - the copy runs under SH_LOCK and releases it; the consumer NEVER waits
//     on the producer's cadence (bounded try-lock);
//   - the review-1 blocker: on contention right after a reconfigure the
//     PREVIOUS texture (already uploaded) is what gets bound — a new-
//     generation entry replaces the old one only after its first successful
//     upload, the old texture is destroyed only then, and a never-uploaded
//     texture is never returned while a previous frame exists;
//   - contention sets the retry flag (takeRetry) exactly once per skipped
//     upload, and the next unlocked call uploads and clears the retry;
//   - only a surface that has never uploaded anything gets a fresh (empty)
//     texture on contention.
// RED CONTROL: the same scenario against the pre-counter-pass algorithm
// (destroy-then-create-then-trylock, reproduced inline) returns a bind
// whose texture never received a writeTexture — the defect the reviewer
// found; the control proves this file can see it.
// Run: node tests/host/test_compositor_shm.js
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

globalThis.GPUTextureUsage = { COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04, RENDER_ATTACHMENT: 0x10 };
const K = require(path.join(ROOT, 'kernel.js'));
const { makeShmUploader, SHM_TRY_SPIN } = require(path.join(ROOT, 'os', 'compositor.js'));

// ---- fake device ----
let texSeq = 0;
function makeDevice() {
  const d = { textures: [], writes: [] };
  d.createTexture = function (desc) {
    const t = { id: ++texSeq, w: desc.size.width, h: desc.size.height, writes: 0, destroyed: false,
                destroy() { this.destroyed = true; } };
    d.textures.push(t);
    return t;
  };
  d.queue = { writeTexture(dst, bytes, layout, size) {
    dst.texture.writes++;
    d.writes.push({ tex: dst.texture.id, first: bytes[0], w: size.width, h: size.height });
  } };
  return d;
}
const bindFor = (tex) => ({ tex });          // a bind group stands in for its texture
function makeSurf(sid, w, h, gen) {
  const sab = new SharedArrayBuffer(K.SH_HDR_BYTES + 2 * w * h * 4);
  const i32 = new Int32Array(sab);
  i32[K.SH_MAGIC] = K.SH_MAGIC_VALUE; i32[K.SH_W] = w; i32[K.SH_H] = h; i32[K.SH_GEN] = gen;
  return { sid, w, h, sab, i32, u8: new Uint8Array(sab) };
}
function present(s, v) {                     // the producer: fill back, flip, seq++
  const front = Atomics.load(s.i32, K.SH_FLIP) & 1, back = 1 - front;
  s.u8.fill(v, K.SH_HDR_BYTES + back * s.w * s.h * 4, K.SH_HDR_BYTES + (back + 1) * s.w * s.h * 4);
  Atomics.store(s.i32, K.SH_FLIP, back); Atomics.add(s.i32, K.SH_SEQ, 1);
}

// ================= the real uploader =================
{
  const dev = makeDevice();
  const stats = { shmContended: 0 };
  const up = makeShmUploader(() => dev, bindFor, stats, K);
  const s = makeSurf(7, 8, 6, 1);
  present(s, 11);
  let b = up.bindFor(s);
  check('first call creates one texture and uploads the front buffer', dev.textures.length === 1 && dev.writes.length === 1 && dev.writes[0].first === 11 && b.tex.id === 1);
  check('SH_LOCK released after the copy', Atomics.load(s.i32, K.SH_LOCK) === 0);
  b = up.bindFor(s);
  check('same (gen, seq): no upload', dev.writes.length === 1 && b.tex.id === 1);
  present(s, 12);
  b = up.bindFor(s);
  check('new seq uploads the new front (12)', dev.writes.length === 2 && dev.writes[1].first === 12 && b.tex.id === 1);

  // equal-size regeneration: a fresh SAB, same dims, new generation
  const s2 = makeSurf(7, 8, 6, 2);
  present(s2, 21);
  b = up.bindFor(s2);
  check('same size, new generation -> NEW texture, uploaded, old destroyed', dev.textures.length === 2 && b.tex.id === 2 && dev.textures[1].writes === 1 && dev.textures[0].destroyed === true);
  check('cache holds exactly the live entry', up.cache.size === 1 && up.cache.get(7).gen === 2);

  // ---- the review-1 blocker: contention right after a reconfigure ----
  const s3 = makeSurf(7, 10, 4, 3);          // a resize: new dims, new generation
  present(s3, 31);
  Atomics.store(s3.i32, K.SH_LOCK, 1);        // producer mid-flip (held)
  const t0 = Date.now();
  b = up.bindFor(s3);
  const dt = Date.now() - t0;
  check('contention on a NEW generation: the PREVIOUS uploaded texture is bound (never a fresh empty one)',
    b.tex.id === 2 && dev.textures[1].writes === 1 && !dev.textures[1].destroyed, JSON.stringify({ bound: b.tex.id }));
  check('...no texture was created or destroyed for the skipped upload', dev.textures.length === 2);
  check('...the consumer did not wait on the producer (' + dt + 'ms)', dt < 200);
  check('...contention counted, retry flagged once', stats.shmContended === 1 && up.takeRetry() === true && up.takeRetry() === false);
  Atomics.store(s3.i32, K.SH_LOCK, 0);        // producer done
  b = up.bindFor(s3);
  check('next call uploads the new generation into a new texture and retires the old one',
    b.tex.id === 3 && dev.textures[2].writes === 1 && dev.writes[dev.writes.length - 1].first === 31 &&
    dev.textures[1].destroyed === true && up.cache.get(7).gen === 3, JSON.stringify(dev.writes.slice(-1)));
  check('...retry not re-flagged by a successful upload', up.takeRetry() === false);

  // contention on a same-generation new seq: previous frame stays too
  present(s3, 32);
  Atomics.store(s3.i32, K.SH_LOCK, 1);
  b = up.bindFor(s3);
  check('contention on a new seq keeps the last uploaded frame (no upload, no new texture)',
    b.tex.id === 3 && dev.textures[2].writes === 1 && dev.textures.length === 3 && stats.shmContended === 2 && up.takeRetry() === true);
  Atomics.store(s3.i32, K.SH_LOCK, 0);
  b = up.bindFor(s3);
  check('...then uploads (32)', dev.textures[2].writes === 2 && dev.writes[dev.writes.length - 1].first === 32);

  // a surface that never uploaded anything, contended: a fresh empty texture is the only honest answer
  const s9 = makeSurf(9, 4, 4, 1);
  present(s9, 91);
  Atomics.store(s9.i32, K.SH_LOCK, 1);
  b = up.bindFor(s9);
  check('never-uploaded surface under contention: a fresh texture, no upload, retry flagged', b.tex.writes === 0 && up.cache.get(9).seq !== Atomics.load(s9.i32, K.SH_SEQ) && up.takeRetry() === true);
  Atomics.store(s9.i32, K.SH_LOCK, 0);
  b = up.bindFor(s9);
  check('...uploads into that texture once the lock is free', b.tex.writes === 1 && dev.writes[dev.writes.length - 1].first === 91);
  check('the try-lock spin bound is small (never a wait on the producer cadence)', SHM_TRY_SPIN <= 1 << 16);
}

// ================= RED CONTROL: the pre-counter-pass algorithm =================
{
  // Reproduced inline from d5a04892's shmBindFor: destroy + create the new
  // entry FIRST, try-lock after. The defect: on contention it returns the
  // fresh, never-uploaded texture.
  const dev = makeDevice();
  const cache = new Map();
  function legacyBindFor(surf) {
    const seq = Atomics.load(surf.i32, K.SH_SEQ), gen = Atomics.load(surf.i32, K.SH_GEN);
    let c = cache.get(surf.sid);
    if (!c || c.w !== surf.w || c.h !== surf.h || c.gen !== gen) {
      if (c) c.tex.destroy();
      const tex = dev.createTexture({ size: { width: surf.w, height: surf.h } });
      c = { gen, seq: seq - 1, w: surf.w, h: surf.h, tex, bind: bindFor(tex), scratch: new Uint8Array(surf.w * surf.h * 4) };
      cache.set(surf.sid, c);
    }
    if (c.seq !== seq) {
      if (Atomics.compareExchange(surf.i32, K.SH_LOCK, 0, 1) !== 0) return c.bind;
      const bytes = surf.w * surf.h * 4, front = Atomics.load(surf.i32, K.SH_FLIP) & 1;
      c.scratch.set(new Uint8Array(surf.sab, K.SH_HDR_BYTES + front * bytes, bytes));
      Atomics.store(surf.i32, K.SH_LOCK, 0);
      dev.queue.writeTexture({ texture: c.tex }, c.scratch, {}, { width: surf.w, height: surf.h });
      c.seq = seq;
    }
    return c.bind;
  }
  const a = makeSurf(1, 8, 6, 1); present(a, 1); legacyBindFor(a);
  const b2 = makeSurf(1, 10, 4, 2); present(b2, 2);
  Atomics.store(b2.i32, K.SH_LOCK, 1);
  const bound = legacyBindFor(b2);
  check('RED CONTROL: the d5a04892 algorithm binds a never-uploaded texture on contention after a reconfigure (the defect)',
    bound.tex.writes === 0 && dev.textures[0].destroyed === true, JSON.stringify({ writes: bound.tex.writes }));
}

console.log(failures ? `\ntest_compositor_shm: ${failures} FAILED` : '\ntest_compositor_shm: all passed');
process.exit(failures ? 1 : 0);
