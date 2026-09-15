#!/usr/bin/env node
// #790 host-side configure identities (host.js createSurfaceSDL, both
// flavors, driven in Node with fake kernel hooks — no boot, no browser):
//   - the WINDOW_RESIZED ring record's serial (word [4]) reaches
//     beginConfigure; the new SAB carries SH_GEN = serial; the first present
//     at the new size acks with (sid, w, h, sab, serial);
//   - an ESTALE reply keeps the OLD buffer (later same-size presents land in
//     it) and is counted (frameStats().staleAcks);
//   - allocation failure DECLINES the serial at once (surfaceConfigure with a
//     null SAB) — no pending state on the host side either: the app keeps its
//     old geometry and presents keep landing in the old buffer;
//   - a newer WINDOW_RESIZED supersedes the host's one outstanding configure;
//   - flips go through the locked mailbox (SH_LOCK free afterwards, seq
//     advanced) and a wedged consumer never wedges the producer past its
//     bound (counted);
//   - the browser flavor's gpu-transport ship carries the committed serial
//     (1 at create, the acked serial after a renegotiation).
// Run: node tests/host/test_surface_configure.js
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

const host = require(path.join(ROOT, 'host.js'));
const K = require(path.join(ROOT, 'kernel.js'));
const L = K.WM_SAB_LAYOUT;
const ENV = 'c';   // host.js ENV_KEY

const mem = new ArrayBuffer(1 << 20);             // wasm "memory": pixels live here
const memU8 = new Uint8Array(mem);
function paint(v, w, h) { memU8.fill(v, 0, w * h * 4); return 0; }   // pixelsPtr 0

function makeHooks() {
  const st = { nextSid: 1, ring: null, fbs: new Map(), configures: [], frames: [], reply: null };
  st.hooks = {
    wmSabLayout: L,
    surfaceCreate: function (w, h, title, sab, ringSab) {
      const sid = st.nextSid++;
      st.fbs.set(sid, sab);
      if (ringSab && !st.ring) st.ring = { i32: new Int32Array(ringSab), cap: new Int32Array(ringSab)[L.irCap] };
      return { sid, lifecycle: 2 };
    },
    surfaceConfigure: function (sid, w, h, sab, serial) {
      st.configures.push({ sid, w, h, sab, serial, gen: sab ? new Int32Array(sab)[L.shGen] : null,
                           front: sab ? frontByte(sab, w, h) : null });
      const r = st.reply || {};
      st.reply = null;
      if (!r.errno && sab) st.fbs.set(sid, sab);
      return r;
    },
    surfaceFrame: function (sid, bmp, serial) { st.frames.push({ sid, w: bmp.width, h: bmp.height, serial }); },
    surfaceDestroy: function () {},
  };
  return st;
}
function frontByte(sab, w, h) {
  const i32 = new Int32Array(sab);
  const front = Atomics.load(i32, L.shFlip) & 1;
  return new Uint8Array(sab)[L.shHdrBytes + front * w * h * 4];
}
function seq(sab) { return Atomics.load(new Int32Array(sab), L.shSeq); }
// Write one WINDOW_RESIZED record into the process ring (what the kernel does).
function pushResized(ring, sid, w, h, serial) {
  const cap2 = ring.cap * 2;
  const wpos = Atomics.load(ring.i32, L.irWpos);
  const base = (L.irHdrBytes >> 2) + (wpos % ring.cap) * L.irRecordWords;
  for (let k = 0; k < L.irRecordWords; k++) ring.i32[base + k] = 0;
  ring.i32[base] = L.ev.WINDOW_RESIZED; ring.i32[base + 1] = sid;
  ring.i32[base + 2] = w; ring.i32[base + 3] = h; ring.i32[base + 4] = serial;
  Atomics.store(ring.i32, L.irWpos, (wpos + 1) % cap2);
}
const ctx = {
  readString: function () { return ''; },
  getMemory: function () { return { buffer: mem }; },
  getExports: function () { return { __sdl_push_window_event: function () {} }; },
};

// ================= headless / shm flavor =================
{
  const st = makeHooks();
  const sdl = host.createSurfaceSDL({ ctx, hooks: st.hooks });
  const env = sdl[ENV];
  const hnd = env.__sdl_create_window(0, 0, 0, 64, 48, 0x20 /* resizable */);
  check('headless: window created', hnd === 1);
  const fb1 = st.fbs.get(1);
  check('create buffer carries generation 1', new Int32Array(fb1)[L.shGen] === 1);
  env.__sdl_update_window_surface(hnd, paint(11, 64, 48), 64, 48, 64 * 4);
  check('present lands in the create buffer (seq 1, front byte 11)', seq(fb1) === 1 && frontByte(fb1, 64, 48) === 11);
  check('SH_LOCK free after a present', new Int32Array(fb1)[L.shLock] === 0);

  // ---- renegotiation with a serial ----
  pushResized(st.ring, 1, 96, 80, 7);
  env.__sdl_pump();
  check('no ack before a new-size present', st.configures.length === 0);
  env.__sdl_update_window_surface(hnd, paint(12, 64, 48), 64, 48, 64 * 4);
  check('an old-size present still lands in the OLD buffer', seq(fb1) === 2 && frontByte(fb1, 64, 48) === 12 && st.configures.length === 0);
  env.__sdl_update_window_surface(hnd, paint(13, 96, 80), 96, 80, 96 * 4);
  const c0 = st.configures[0];
  check('the first new-size present acks NAMING serial 7 with SH_GEN 7 and the frame already in front',
    st.configures.length === 1 && c0.sid === 1 && c0.w === 96 && c0.h === 80 && c0.serial === 7 && c0.gen === 7 && c0.front === 13,
    JSON.stringify(c0));
  const fb7 = c0.sab;
  env.__sdl_update_window_surface(hnd, paint(14, 96, 80), 96, 80, 96 * 4);
  check('after the ack, presents land in the new buffer', seq(fb7) === 2 && frontByte(fb7, 96, 80) === 14 && seq(fb1) === 2);

  // ---- ESTALE keeps the old buffer, releases the new one ----
  pushResized(st.ring, 1, 120, 90, 8);
  env.__sdl_pump();
  st.reply = { errno: 'ESTALE' };
  env.__sdl_update_window_surface(hnd, paint(15, 120, 90), 120, 90, 120 * 4);
  check('ack for serial 8 was attempted', st.configures.length === 2 && st.configures[1].serial === 8);
  env.__sdl_update_window_surface(hnd, paint(16, 96, 80), 96, 80, 96 * 4);
  check('ESTALE: the old (serial 7) buffer stays live', seq(fb7) === 3 && frontByte(fb7, 96, 80) === 16);
  check('ESTALE counted in frameStats', sdl.frameStats().staleAcks === 1, JSON.stringify(sdl.frameStats()));
  env.__sdl_update_window_surface(hnd, paint(17, 120, 90), 120, 90, 120 * 4);
  check('a later present at the refused size does NOT re-ack (nothing pending host-side)', st.configures.length === 2);

  // ---- a newer request supersedes the host's one outstanding configure ----
  pushResized(st.ring, 1, 130, 91, 9);
  pushResized(st.ring, 1, 140, 92, 10);
  env.__sdl_pump();
  env.__sdl_update_window_surface(hnd, paint(18, 130, 91), 130, 91, 130 * 4);
  check('a present at the superseded size (serial 9) acks nothing', st.configures.length === 2);
  env.__sdl_update_window_surface(hnd, paint(19, 140, 92), 140, 92, 140 * 4);
  check('the newest (serial 10) acks', st.configures.length === 3 && st.configures[2].serial === 10 && st.configures[2].gen === 10);

  // ---- allocation failure declines the serial ----
  const RealSAB = globalThis.SharedArrayBuffer;
  globalThis.SharedArrayBuffer = class extends RealSAB {
    constructor(n) { if (n > 1 << 20) throw new RangeError('test: allocation refused'); super(n); }
  };
  pushResized(st.ring, 1, 2000, 2000, 11);
  env.__sdl_pump();
  globalThis.SharedArrayBuffer = RealSAB;
  const d = st.configures[3];
  check('allocation failure DECLINES serial 11 immediately (null SAB, w/h named)',
    st.configures.length === 4 && d && d.sab === null && d.serial === 11 && d.w === 2000 && d.h === 2000, JSON.stringify(d));
  env.__sdl_update_window_surface(hnd, paint(20, 140, 92), 140, 92, 140 * 4);
  const fb10 = st.configures[2].sab;
  check('after the decline, presents keep landing in the committed (serial 10) buffer', seq(fb10) === 2 && frontByte(fb10, 140, 92) === 20);
  check('no further ack attempts', st.configures.length === 4);

  // ---- the producer never wedges past its bound on a held consumer lock ----
  const i32 = new Int32Array(fb10);
  Atomics.store(i32, L.shLock, 1);                   // a consumer that never releases
  const t0 = Date.now();
  env.__sdl_update_window_surface(hnd, paint(21, 140, 92), 140, 92, 140 * 4);
  const dt = Date.now() - t0;
  check('present under a wedged lock completes (bounded wait, ' + dt + 'ms) and flips', dt < 2000 && seq(fb10) === 3 && frontByte(fb10, 140, 92) === 21);
  check('...and is counted as a flip miss', sdl.frameStats().flipMisses >= 1 && Atomics.load(i32, L.shLock) === 1);
  Atomics.store(i32, L.shLock, 0);
}

// ================= browser flavor: gpu-transport frames carry the serial =================
{
  class FakeOffscreenCanvas {
    constructor(w, h) { this.width = w; this.height = h; }
    getContext() { return null; }
    transferToImageBitmap() { return { width: this.width, height: this.height, close() {} }; }
  }
  globalThis.OffscreenCanvas = FakeOffscreenCanvas;
  Object.defineProperty(globalThis, 'navigator', { value: { gpu: {} }, configurable: true });
  const st = makeHooks();
  let tickN = 1;
  st.hooks.vsyncEnabled = function () { return true; };
  st.hooks.vsyncSeq = function () { return tickN; };
  const sdl = host.createSurfaceSDL({ ctx, hooks: st.hooks });
  const env = sdl[ENV];
  const hnd = env.__sdl_create_window(0, 0, 0, 64, 48, 0x20);
  check('browser flavor: window created', !!hnd);
  const bound = sdl.webgpuConfig.bindWindow(hnd);
  bound.canvas.width = 64; bound.canvas.height = 48;   // what wgpuSurfaceConfigure does
  bound.present();
  check('first gpu ship carries serial 1 (create generation)', st.frames.length === 1 && st.frames[0].serial === 1 && st.frames[0].w === 64, JSON.stringify(st.frames));
  pushResized(st.ring, 1, 96, 80, 5);
  env.__sdl_pump();
  tickN++;
  bound.present();
  check('the acking ship acks serial 5 FIRST (gen 5) then ships under it',
    st.configures.length === 1 && st.configures[0].serial === 5 && st.configures[0].gen === 5 &&
    st.frames.length === 2 && st.frames[1].serial === 5 && st.frames[1].w === 96 && st.frames[1].h === 80,
    JSON.stringify([st.configures, st.frames]));
  tickN++;
  bound.present();
  check('later ships keep the committed serial', st.frames.length === 3 && st.frames[2].serial === 5);
  // ESTALE on the gpu path: the ship still goes out under the OLD serial
  pushResized(st.ring, 1, 100, 90, 6);
  env.__sdl_pump();
  st.reply = { errno: 'ESTALE' };
  tickN++;
  bound.present();
  check('a refused gpu ack ships the frame under the still-committed serial (5), counted',
    st.frames.length === 4 && st.frames[3].serial === 5 && sdl.frameStats().staleAcks === 1, JSON.stringify(st.frames[3]));
  // the shm path in the browser flavor (SDL_UpdateWindowSurface) shares the lock/serial machinery
  const h2 = env.__sdl_create_window(0, 0, 0, 32, 24, 0x20);
  env.__sdl_update_window_surface(h2, paint(9, 32, 24), 32, 24, 32 * 4);
  const fb2 = st.fbs.get(2);
  check('browser-flavor shm present: gen 1, seq 1, lock free', new Int32Array(fb2)[L.shGen] === 1 && seq(fb2) === 1 && new Int32Array(fb2)[L.shLock] === 0);
}

console.log(failures ? `\ntest_surface_configure: ${failures} FAILED` : '\ntest_surface_configure: all passed');
process.exit(failures ? 1 : 0);
