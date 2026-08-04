#!/usr/bin/env node
// Producer-side GPU present backpressure (ticket #484): the browser-flavor
// present tail (presentTo) ships at most ONE transferToImageBitmap per kernel
// vsync tick per sid — the fix for the poll-only-loop tab-crash class (an
// unclamped loop pushed ~8,000 ImageBitmaps/s into the kernel worker's
// unbounded message queue until the browser GPU process died). Mailbox
// newest-wins semantics: a clamped present ships nothing, but its canvas is
// HELD and re-ships through the gate at SDL_PollEvent's pump (__sdl_pump) or
// unconditionally at the park seams (pumpWait entry), so the freshest frame
// is never lost. This file drives the clamp deterministically in Node with a
// fake vsync tick (real Chromium rate evidence lives in the browser sweep's
// os-pollball.mjs); the sibling test_gpu_present_binding.js owns the
// per-window binding semantics.
//
// Run: node tests/host/test_gpu_present_clamp.js
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '../..');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

/* ---- fake browser surface: just enough for the GPU present tail ---- */
let bitmapsMade = 0;
class FakeOffscreenCanvas {
  constructor(w, h) { this.width = w; this.height = h; }
  getContext() { return null; }        // clamp path never needs a context
  transferToImageBitmap() {
    bitmapsMade++;
    return { width: this.width, height: this.height, close: function () {} };
  }
}
globalThis.OffscreenCanvas = FakeOffscreenCanvas;
Object.defineProperty(globalThis, 'navigator',
  { value: { gpu: {} }, configurable: true });

const host = require(path.join(ROOT, 'host.js'));
const { WM_SAB_LAYOUT } = require(path.join(ROOT, 'kernel.js'));
const ENV = 'c';   // host.js ENV_KEY

const ctx = {
  readString: function () { return ''; },
  getMemory: function () { return { buffer: new ArrayBuffer(64) }; },
  getExports: function () { return {}; },
};
function makeFlavor(vsync) {
  const st = { frames: 0, tick: 100, nextSid: 1 };
  const hooks = {
    wmSabLayout: WM_SAB_LAYOUT,
    surfaceCreate: function () { return { sid: st.nextSid++ }; },
    surfaceFrame: function () { st.frames++; },
    surfaceDestroy: function () {},
  };
  if (vsync) {
    hooks.vsyncEnabled = function () { return true; };
    hooks.vsyncSeq = function () { return st.tick; };
  }
  st.sdl = host.createSurfaceSDL({ ctx: ctx, hooks: hooks });
  return st;
}

const st = makeFlavor(true);
const env = st.sdl[ENV];
const handle = env.__sdl_create_window(0, 0, 0, 64, 48, 0);
check('window created', !!handle);
const bound = st.sdl.webgpuConfig.bindWindow(handle);
check('per-window present binding exists (A4)', !!bound);

// 1) a poll-only flood inside ONE tick ships exactly one frame — the queue
//    (and the GPU bitmap churn) physically cannot grow.
for (let i = 0; i < 1000; i++) bound.present();
check('flood in one tick ships exactly 1 frame (1 bitmap made)',
  st.frames === 1 && bitmapsMade === 1, `frames=${st.frames} bitmaps=${bitmapsMade}`);

// 2) the next tick ships exactly one more (the freshest), flood stays clamped
st.tick++;
for (let i = 0; i < 1000; i++) bound.present();
check('next tick ships exactly 1 more', st.frames === 2, `frames=${st.frames}`);

// 3) park entry (pumpWait — SDL_WaitEvent/GetMessage/SDL_Delay) ships the
//    held trailing frame unconditionally: an app going quiet must not leave
//    a stale frame on screen. One frame per park cannot flood.
env.__sdl_pump_wait(0);
check('park entry flushes the held trailing frame', st.frames === 3, `frames=${st.frames}`);
env.__sdl_pump_wait(0);
check('second park ships nothing (no held frame left)', st.frames === 3, `frames=${st.frames}`);

// 4) SDL_PollEvent's pump retries THROUGH the gate: same tick keeps holding
//    (a hot loop stays clamped), a fresh tick ships the held frame (a loop
//    that stopped presenting still gets its last frame out).
bound.present(); bound.present();     // same tick as the park flush: both held
const before = st.frames;
env.__sdl_pump();
check('pump on the same tick keeps the clamp', st.frames === before, `frames=${st.frames}`);
st.tick++;
env.__sdl_pump();
check('pump on a fresh tick ships the held frame', st.frames === before + 1, `frames=${st.frames}`);

// 5) a paced app (one present per tick — every SDL_Delay(16) corpus loop)
//    is untouched: every frame ships, nothing held, nothing dropped.
const paced0 = st.frames;
for (let i = 0; i < 10; i++) { st.tick++; bound.present(); }
check('paced one-present-per-tick app ships every frame', st.frames === paced0 + 10,
  `frames=${st.frames}`);

// 6) destroy clears the clamp state with the sid
bound.present();                      // held (same tick as the last paced ship)
env.__sdl_destroy_window(handle);
const d0 = st.frames;
env.__sdl_pump_wait(0);
check('destroyed window ships nothing at park (held state cleared)',
  st.frames === d0, `frames=${st.frames}`);

// 7) no vsync advertised (older embedder): the clock-fallback gate is OPEN
//    for a first present — the clamp degrades, never wedges.
const st2 = makeFlavor(false);
const env2 = st2.sdl[ENV];
const b2 = st2.sdl.webgpuConfig.bindWindow(env2.__sdl_create_window(0, 0, 0, 8, 8, 0));
b2.present();
check('vsync-less flavor ships its first present (clock-fallback gate opens)',
  st2.frames === 1, `frames=${st2.frames}`);

console.log(failures ? '\ngpu present clamp: ' + failures + ' FAILED' : '\ngpu present clamp: PASS');
process.exit(failures ? 1 : 0);
