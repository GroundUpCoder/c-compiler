#!/usr/bin/env node
// Producer-side GPU present backpressure (ticket #484): the browser-flavor
// present tail (presentTo) ships at most ONE transferToImageBitmap per kernel
// vsync tick per sid — the fix for the poll-only-loop tab-crash class (an
// unclamped loop pushed ~8,000 ImageBitmaps/s into the kernel worker's
// unbounded message queue until the browser GPU process died). Mailbox
// newest-wins semantics: a clamped present ships nothing, but its canvas is
// HELD and re-ships through the gate at SDL_PollEvent's pump (__sdl_pump),
// gated at SHORT-timeout parks (#551 'park' mode: the SDL_Delay(1) frame
// loop parks hundreds of times a second, and the old unconditional flush
// there made ships == presents — which burned Chromium's ~16.7k lifetime
// budget for ImageBitmap ships out of a never-yielding worker in ~2 min and
// destroyed the compositor's device), and unconditionally at REAL parks
// (>=15ms/indefinite — self-limiting, and the app may never present again),
// so the freshest frame is never lost. Since the #551 redesign the same
// tail also carries the BLOCKING-LOOP REFUSAL (sections 8-9 below): a
// present issued while main() is on the stack refuses loudly (fd-2
// message, exit 69, nothing shipped) and the post-main callback path is
// untouched. This file drives the clamp
// deterministically in Node with a
// fake vsync tick (real Chromium rate evidence lives in the browser sweep's
// os-pollball.mjs, refusal evidence in os-loopguard.mjs); the sibling
// test_gpu_present_binding.js owns the per-window binding semantics.
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

// 3) a REAL park entry (pumpWait >= 15ms — SDL_WaitEvent/GetMessage/long
//    SDL_Delay) ships the held trailing frame unconditionally: an app going
//    quiet must not leave a stale frame on screen. One frame per real park
//    cannot flood.
env.__sdl_pump_wait(1000);
check('real park entry flushes the held trailing frame', st.frames === 3, `frames=${st.frames}`);
env.__sdl_pump_wait(1000);
check('second park ships nothing (no held frame left)', st.frames === 3, `frames=${st.frames}`);

// 3b) #551: a SHORT-timeout park (the SDL_Delay(1) frame-loop shape) keeps
//    the clamp — same tick, inside the 17ms wall-escape window, the held
//    frame stays held. The wall escape reads the real clock, so the trial
//    MEASURES itself (the 7b pattern): only a trial whose whole
//    ship→hold→park sequence fits inside 17ms asserts; a preempted trial
//    retries under a deadline, and exhausting it is a loud FAIL.
{
  let proved = false, violated = '';
  const deadline = Date.now() + 2000;
  while (!proved && !violated && Date.now() < deadline) {
    st.tick++;
    const t0 = Date.now();
    bound.present();                    // fresh tick: ships, stamps the wall clock
    const shipped = st.frames;
    bound.present();                    // same tick: held
    env.__sdl_pump_wait(1);             // short park — must keep the clamp
    const dt = Date.now() - t0;
    if (st.frames === shipped) { if (dt < 17) proved = true; continue; }
    if (dt < 17) violated = `short park SHIPPED ${dt}ms after the tick's ship`;
    // dt >= 17: the wall escape legitimately opened (a stall) — retry.
  }
  check('short park (delay-loop shape) keeps the clamp within the tick',
    proved && !violated, violated || `proved=${proved} frames=${st.frames}`);
}
// ...and the held frame ships once the tick advances, even through the
// short-park path (deterministic: the tick gate, not the wall clock).
{
  const before = st.frames;
  st.tick++;
  env.__sdl_pump_wait(1);
  check('short park ships the held frame once the tick advances',
    st.frames === before + 1, `frames=${st.frames}`);
}

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
env.__sdl_pump_wait(1000);
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

// 7b) the fallback's HELD branch — the one branch live on a vsync-less
//    embedder. A real clock cannot be told "advance less than 8ms", so the
//    trial MEASURES itself instead of assuming adjacency: present (ships,
//    stamping the window at ~tA), immediately present again, and only a
//    trial whose total elapsed dt sits inside one window asserts — with
//    g.ms >= tA, dt < CLAMP_MS forces the second decision inside the
//    window, so a hold is mandatory and a SHIP is a clamp violation (fail
//    loud, no retry). A preempted trial (GC pause / --under-load stall
//    between two adjacent calls, dt >= CLAMP_MS) retries under a deadline;
//    exhausting the deadline is a loud FAIL, never a vacuous pass.
const CLAMP_MS = 8;   // must match host.js PRESENT_CLAMP_MS
let heldProved = false, violated = '';
const trialDeadline = Date.now() + 2000;
while (!heldProved && !violated && Date.now() < trialDeadline) {
  const before = st2.frames;
  const tA = Date.now();
  b2.present();
  if (st2.frames !== before + 1) continue;  // still inside the previous window: spin till it ships
  b2.present();
  const dt = Date.now() - tA;
  if (st2.frames === before + 2) {
    if (dt < CLAMP_MS) violated = `second present SHIPPED ${dt}ms into the window`;
    continue;                               // dt >= CLAMP_MS: a stall between the calls, retry
  }
  if (dt < CLAMP_MS) heldProved = true;     // measured-valid trial: held inside one window
  // held with dt >= CLAMP_MS is indeterminate (the decision instant was
  // earlier than tA+dt) — retry rather than assert on it.
}
check('clock fallback holds a same-window present (self-measured trial)',
  heldProved && !violated, violated || `proved=${heldProved} frames=${st2.frames}`);
const heldAt = st2.frames;
env2.__sdl_pump_wait(1000);   // a REAL park (#551): unconditional flush
check('clock fallback: the held frame ships at a real park (never lost)',
  st2.frames === heldAt + 1, `frames=${st2.frames}`);

// 8) the #551 blocking-loop refusal: a GPU-transport present issued while
//    main() is on the stack (setMainLive(true) — runModule's arming) is
//    refused at the FIRST present: nothing ships, the message lands on
//    fd 2, the exit reports 69 through hooks.exit exactly once, and the
//    thrown error carries sdlRefusalExit for runModule's clean unwind.
{
  const st3 = { frames: 0, tick: 100, nextSid: 1, exits: [], fd2: '' };
  const hooks3 = {
    wmSabLayout: WM_SAB_LAYOUT,
    surfaceCreate: function () { return { sid: st3.nextSid++ }; },
    surfaceFrame: function () { st3.frames++; },
    surfaceDestroy: function () {},
    vsyncEnabled: function () { return true; },
    vsyncSeq: function () { return st3.tick; },
    exit: function (code) { st3.exits.push(code); },
  };
  const ctx3 = {
    readString: function () { return ''; },
    getMemory: function () { return { buffer: new ArrayBuffer(64) }; },
    getExports: function () { return {}; },
    fs: { write: function (fd, buf, count) {
      if (fd === 2) st3.fd2 += Buffer.from(buf.subarray(0, count)).toString('utf-8');
      return count;
    } },
  };
  const sdl3 = host.createSurfaceSDL({ ctx: ctx3, hooks: hooks3,
    proc: { name: 'blockyapp', pid: 42 } });
  const env3 = sdl3[ENV];
  const b3 = sdl3.webgpuConfig.bindWindow(env3.__sdl_create_window(0, 0, 0, 32, 24, 0));
  const bitmaps0 = bitmapsMade;
  sdl3.setMainLive(true);              // runModule: wasm entry is on the stack
  let threw = null;
  try { b3.present(); } catch (e) { threw = e; }
  check('armed present refuses (throws with sdlRefusalExit=69)',
    threw && threw.sdlRefusalExit === 69, threw && threw.message);
  check('refusal ships NOTHING (no frame, no bitmap)',
    st3.frames === 0 && bitmapsMade === bitmaps0,
    `frames=${st3.frames} bitmaps=${bitmapsMade - bitmaps0}`);
  check('refusal reports exit 69 through the kernel handshake exactly once',
    st3.exits.length === 1 && st3.exits[0] === 69, JSON.stringify(st3.exits));
  check('refusal message lands on the app fd 2',
    st3.fd2.includes('GPU rendering from a blocking main loop is not supported'),
    st3.fd2.slice(0, 120));
  check('message teaches SDL_MAIN_USE_CALLBACKS / SDL_AppIterate',
    st3.fd2.includes('SDL_MAIN_USE_CALLBACKS') && st3.fd2.includes('SDL_AppIterate'));
  check('message carries the runtime identity (program, pid)',
    st3.fd2.includes('blockyapp (pid 42)'), st3.fd2);
  check('message quotes no vendor-specific budget figure',
    !/16[,.]?7\d\d/.test(st3.fd2));
  // Re-entry (the app unwound into another present somehow): keeps refusing,
  // never double-reports the exit.
  let threw2 = null;
  try { b3.present(); } catch (e) { threw2 = e; }
  check('second armed present still refuses without re-reporting exit',
    threw2 && threw2.sdlRefusalExit === 69 && st3.exits.length === 1,
    JSON.stringify(st3.exits));
}

// 9) ...and the callback path is untouched: main returned (setMainLive
//    false — the ONLY state the animation-frame loop presents in), the
//    same first present ships.
{
  const st4 = { frames: 0, tick: 100, nextSid: 1 };
  const hooks4 = {
    wmSabLayout: WM_SAB_LAYOUT,
    surfaceCreate: function () { return { sid: st4.nextSid++ }; },
    surfaceFrame: function () { st4.frames++; },
    surfaceDestroy: function () {},
    vsyncEnabled: function () { return true; },
    vsyncSeq: function () { return st4.tick; },
    exit: function () { throw new Error('exit must not be called'); },
  };
  const sdl4 = host.createSurfaceSDL({ ctx: ctx, hooks: hooks4,
    proc: { name: 'cbapp', pid: 43 } });
  const env4 = sdl4[ENV];
  const b4 = sdl4.webgpuConfig.bindWindow(env4.__sdl_create_window(0, 0, 0, 32, 24, 0));
  sdl4.setMainLive(true);
  sdl4.setMainLive(false);             // runModule: main() returned
  b4.present();
  check('post-main (callback path) present ships normally', st4.frames === 1,
    `frames=${st4.frames}`);
}

console.log(failures ? '\ngpu present clamp: ' + failures + ' FAILED' : '\ngpu present clamp: PASS');
process.exit(failures ? 1 : 0);
