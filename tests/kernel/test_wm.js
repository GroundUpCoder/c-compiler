#!/usr/bin/env node
// WM surface semantics (todos/WM.md, todos/0007) without wasm: fake workers
// over a brokered kernel, the test playing the process side of the kernel-
// page protocol (test_sockets.js pattern). Covers: SURFACE_CREATE handshake
// (SABs precede the RPC on the same FIFO channel), mailbox present + kernel
// screenshots, the screen composite with kernel chrome, input routing (focus,
// hit-test, title drag, close box), the agent inject API, input-ring overflow
// + a storm (spike S5), lifecycle cleanup on exit and SIGKILL, and hung-app
// containment (#486: an ignored close request force-quits the owner).
//
// Run: node tests/kernel/test_wm.js
'use strict';
const path = require('path');
const K = require(path.resolve(__dirname, '../../kernel.js'));
const { BLOCK_FS } = require(path.resolve(__dirname, '../../host.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}
const tick = () => new Promise((r) => setImmediate(r));

// ---- fake worker plumbing (test_pipes.js / test_sockets.js shape) ----
const workers = new Map();
function createWorker(procSpec) {
  const h = {
    procSpec, msg: null, terminated: false,
    postMessage() {},
    onMessage(fn) { h.msg = fn; },
    onExit(fn) { h.exitCb = fn; },
    terminate() { h.terminated = true; },
  };
  workers.set(procSpec.pid, h);
  return h;
}
const images = new Map([
  ['/bin/init', new Uint8Array([1])],
  ['/bin/app', new Uint8Array([2])],
]);
const store = new BLOCK_FS.MemoryByteStore(1 << 20);
const kfs = BLOCK_FS.createV4(store);
const ptrLockEvents = [];   // onPointerLock wanted-state transitions (0018)
const logLines = [];        // kernel log capture — the #486 reason strings
const kernel = new K.Kernel({
  fs: kfs,
  createWorker,
  loadImage: (p) => images.get(p) || null,
  onHalt: () => {},
  onPointerLock: (wanted) => ptrLockEvents.push(wanted),
  log: (m) => logLines.push(m),
  screen: { w: 640, h: 480 },
  hungGraceMs: 300,         // #486: short close-request grace so the
                            // hung-app legs run in test time (default 5s)
});

function page(pid) {
  const pcb = kernel.process(pid);
  return { i32: new Int32Array(pcb.page), u8: new Uint8Array(pcb.page) };
}
function submit(pid, op, req) {
  const h = workers.get(pid);
  const { i32, u8 } = page(pid);
  K.writePayload(i32, u8, req);
  Atomics.store(i32, K.KP_RPC_OP, op);
  Atomics.store(i32, K.KP_RPC_STATE, K.RPC_REQUEST);
  h.msg({ type: 'krpc' });
  return {
    async finish() {
      while (Atomics.load(i32, K.KP_RPC_STATE) !== K.RPC_DONE) await tick();
      const resp = K.readPayload(i32, u8);
      Atomics.store(i32, K.KP_RPC_STATE, K.RPC_IDLE);
      return resp;
    },
  };
}
const rpc = (pid, op, req) => submit(pid, op, req).finish();

// ---- surface-side helpers (what host.js's surface SDL backend does) ----
function makeFb(w, h) {
  const sab = new SharedArrayBuffer(K.SH_HDR_BYTES + 2 * w * h * 4);
  const i32 = new Int32Array(sab);
  i32[K.SH_MAGIC] = K.SH_MAGIC_VALUE;
  i32[K.SH_W] = w; i32[K.SH_H] = h; i32[K.SH_FORMAT] = 0;
  return { sab, i32, u8: new Uint8Array(sab), w, h };
}
function makeRing(cap) {
  const sab = new SharedArrayBuffer(K.IR_HDR_BYTES + cap * K.IR_RECORD_WORDS * 4);
  new Int32Array(sab)[K.IR_CAP] = cap;
  return { sab, i32: new Int32Array(sab), f32: new Float32Array(sab), cap };
}
// Fill the BACK buffer with one solid RGBA color, then flip (mailbox present).
function present(fb, rgba) {
  const front = Atomics.load(fb.i32, K.SH_FLIP) & 1;
  const back = 1 - front;
  const base = K.SH_HDR_BYTES + back * fb.w * fb.h * 4;
  for (let i = 0; i < fb.w * fb.h; i++) fb.u8.set(rgba, base + i * 4);
  Atomics.store(fb.i32, K.SH_FLIP, back);
  Atomics.add(fb.i32, K.SH_SEQ, 1);
}
function drain(ring) {
  // The owner focus pair (todos/0256, FOCUS_GAINED/LOST) interleaves with
  // input at every focus transition by design; this file asserts INPUT
  // routing sequences, so the pair is filtered here — its own coverage
  // lives in test_wm_anchored.js.
  const out = [];
  const cap2 = ring.cap * 2;
  let rpos = Atomics.load(ring.i32, K.IR_RPOS);
  while (rpos !== Atomics.load(ring.i32, K.IR_WPOS)) {
    const base = (K.IR_HDR_BYTES >> 2) + (rpos % ring.cap) * K.IR_RECORD_WORDS;
    const rec = { type: ring.i32[base], win: ring.i32[base + 1], w: [] };
    for (let k = 2; k < 8; k++) rec.w.push(ring.i32[base + k]);
    rec.f = [ring.f32[base + 2], ring.f32[base + 3]];
    out.push(rec);
    rpos = (rpos + 1) % cap2;
    Atomics.store(ring.i32, K.IR_RPOS, rpos);
  }
  return out.filter((e) => e.type !== K.WMEV.FOCUS_GAINED && e.type !== K.WMEV.FOCUS_LOST);
}
const px = (shot, x, y) => Array.from(shot.rgba.subarray((y * shot.w + x) * 4, (y * shot.w + x) * 4 + 4));

(async () => {
  const initPid = await kernel.boot({ path: '/bin/init' });
  check('boots', initPid === 1);
  const r1 = await rpc(1, K.OP.SPAWN, { path: '/bin/app', argv: ['app'], envp: [], actions: [], flags: 0 });
  const appPid = r1.pid;
  check('spawned app', appPid > 1);

  // ---- create: handshake + validation ----
  const bad = await rpc(appPid, K.OP.SURFACE_CREATE, { w: 32, h: 32, title: 'x' });
  check('create without SABs -> EINVAL', bad.errno === 'EINVAL');

  const fb1 = makeFb(80, 48);
  const ring1 = makeRing(256);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: fb1.sab, ring: ring1.sab });
  // flags bit2 = resizable (todos/0021) — the resize legs below need it.
  const c1 = await rpc(appPid, K.OP.SURFACE_CREATE, { w: 80, h: 48, title: 'app one', flags: 4 });
  check('create -> sid 1', c1.sid === 1, JSON.stringify(c1));
  check('placement below the title bar', c1.y >= K.WM_TITLE_H, c1.y);

  const wrong = makeFb(16, 16);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: wrong.sab, ring: null });
  const badDim = await rpc(appPid, K.OP.SURFACE_CREATE, { w: 32, h: 32, title: 'x' });
  check('create with mismatched fb dims -> EINVAL', badDim.errno === 'EINVAL');

  let list = kernel.wmList();
  check('wmList has the window, focused', list.length === 1 && list[0].sid === 1 &&
    list[0].focused && list[0].title === 'app one', JSON.stringify(list));
  check('no WM subscribed: created MAPPED (todos/0069 fallback is pre-0069 exact)',
    list[0].mapped === true, JSON.stringify(list[0]));

  // ---- present + surface screenshot ----
  present(fb1, [255, 0, 0, 255]);                     // red frame
  let shot = kernel.wmScreenshot(1);
  check('screenshot sees the presented frame', String(px(shot, 32, 24)) === '255,0,0,255', px(shot, 32, 24));
  present(fb1, [0, 255, 0, 255]);                     // green frame (flips back)
  shot = kernel.wmScreenshot(1);
  check('second present flips buffers', String(px(shot, 1, 1)) === '0,255,0,255', px(shot, 1, 1));
  check('frameSeq advanced', kernel.wmList()[0].frameSeq === 2, kernel.wmList()[0].frameSeq);

  // ---- screen composite: desktop, chrome, client pixels ----
  const s1 = kernel.wmList()[0];
  let screen = kernel.wmScreenshotScreen();
  check('composite: desktop teal at a corner', String(px(screen, 639, 479)) === '0,128,128,255', px(screen, 639, 479));
  check('composite: client pixels at (x,y)', String(px(screen, s1.x + 2, s1.y + 2)) === '0,255,0,255', px(screen, s1.x + 2, s1.y + 2));
  check('composite: focused title bar navy', String(px(screen, s1.x + 2, s1.y - 2)) === '0,0,128,255', px(screen, s1.x + 2, s1.y - 2));
  check('composite: close box drawn', String(px(screen,
    s1.x + s1.w - K.WM_CLOSE_PAD - 2, s1.y - K.WM_TITLE_H + K.WM_CLOSE_PAD + 2)) === '192,192,192,255');

  // ---- keyboard routing to the focused window ----
  const { i32: kp1 } = page(appPid);
  const bellBefore = Atomics.load(kp1, K.KP_DOORBELL);
  kernel.wmKey(true, 4, 97, 0, false);                // 'a' down
  kernel.wmKey(false, 4, 97, 0, false);
  let evs = drain(ring1);
  check('key events routed (down+up), windowId set',
    evs.length === 2 && evs[0].type === K.WMEV.KEYDOWN && evs[1].type === K.WMEV.KEYUP &&
    evs[0].win === 1 && evs[0].w[0] === 4 && evs[0].w[1] === 97, JSON.stringify(evs));
  check('doorbell rung for input', Atomics.load(kp1, K.KP_DOORBELL) > bellBefore);

  // ---- window cycling chord with NO subscriber (todos/0032): the chord
  // is NOT recognized — Alt+Tab lands in the focused app like any other
  // key (the kernel never silently eats keystrokes) ----
  kernel.wmKey(true, 43, 9, 0x140, false);            // Ctrl+Alt+Tab down
  kernel.wmKey(false, 43, 9, 0x140, false);
  evs = drain(ring1);
  check('no WM: the cycle chord passes through to the app',
    evs.length === 2 && evs[0].type === K.WMEV.KEYDOWN && evs[0].w[0] === 43 &&
    evs[0].w[2] === 0x140 && evs[1].type === K.WMEV.KEYUP, JSON.stringify(evs));
  check('wmCycle refuses with no subscriber: ENODEV (cycling IS policy)',
    kernel.wmCycle(1) === 'ENODEV');

  // ---- the Aero Snap chord with NO subscriber (todos/0095): GUI+arrow is
  // NOT recognized — it lands in the focused app like any other key ----
  kernel.wmKey(true, 80, 1073741904, 0x400, false);   // Win+Left down
  kernel.wmKey(false, 80, 1073741904, 0x400, false);
  evs = drain(ring1);
  check('no WM: the snap chord passes through to the app',
    evs.length === 2 && evs[0].type === K.WMEV.KEYDOWN && evs[0].w[0] === 80 &&
    evs[0].w[2] === 0x400 && evs[1].type === K.WMEV.KEYUP, JSON.stringify(evs));
  check('wmSnap refuses with no subscriber: ENODEV (snap IS policy)',
    kernel.wmSnap(0) === 'ENODEV');

  // ---- the screensaver mechanism (todos/0096): the kernel's idle clock
  // stamps at the wmKey/wmPointer entries; the SAVER gesture is
  // subscriber-gated like every other policy gesture ----
  check('wmIdleMs: the key input above stamped the idle clock',
    kernel.wmIdleMs() < 30000, kernel.wmIdleMs());
  kernel._wmLastInput -= 60000;                       // pretend a minute idle
  check('wmIdleMs grows without input', kernel.wmIdleMs() >= 60000, kernel.wmIdleMs());
  kernel.wmPointer('move', 630, 470, {});             // bare desktop corner
  check('wmPointer stamps the idle clock', kernel.wmIdleMs() < 30000, kernel.wmIdleMs());
  check('wmSaver refuses with no subscriber: ENODEV (the saver IS policy)',
    kernel.wmSaver() === 'ENODEV');
  drain(ring1);                                       // shed any motion noise

  // ---- pointer: client hit, local coords ----
  let act = kernel.wmPointer('down', s1.x + 10, s1.y + 20, { button: 1 });
  kernel.wmPointer('up', s1.x + 10, s1.y + 20, { button: 1 });
  evs = drain(ring1);
  check('client click routed with LOCAL coords', act === 'client' &&
    evs.length === 2 && evs[0].type === K.WMEV.MOUSEBUTTONDOWN &&
    evs[0].f[0] === 10 && evs[0].f[1] === 20, JSON.stringify(evs));

  // ---- title drag moves the window ----
  const x0 = s1.x, y0 = s1.y;
  act = kernel.wmPointer('down', x0 + 5, y0 - 10, {});        // grab the bar
  check('title mousedown starts a drag', act === 'drag-start');
  kernel.wmPointer('move', x0 + 45, y0 + 20, {});
  kernel.wmPointer('up', x0 + 45, y0 + 20, {});
  const moved = kernel.wmList()[0];
  check('drag moved the window (+40,+30)', moved.x === x0 + 40 && moved.y === y0 + 30,
    JSON.stringify([moved.x, moved.y, x0, y0]));
  check('drag did not leak events to the app', drain(ring1).length === 0);

  // ---- title double-click -> the maximize gesture (todos/0025) ----
  // Mechanism only here (no WM subscribed, the event goes nowhere; the
  // policy round-trip lives in test_wm_policy.js). opts.t drives the clock
  // deterministically. A second down within the interval+slop returns
  // 'title-activate' and starts NO drag; slow or far-apart pairs drag.
  const m0 = kernel.wmList()[0];
  act = kernel.wmPointer('down', m0.x + 5, m0.y - 10, { t: 1000 });
  check('first title down is a plain drag-start', act === 'drag-start', act);
  kernel.wmPointer('up', m0.x + 5, m0.y - 10, { t: 1010 });
  act = kernel.wmPointer('down', m0.x + 5, m0.y - 10, { t: 1200 });
  check('quick second title down -> title-activate', act === 'title-activate', act);
  kernel.wmPointer('move', m0.x + 200, m0.y + 200, {});  // desktop; a live drag would capture it
  check('the activating down started NO drag (window unmoved)',
    kernel.wmList()[0].x === m0.x && kernel.wmList()[0].y === m0.y,
    JSON.stringify([kernel.wmList()[0].x, m0.x]));
  kernel.wmPointer('up', m0.x + 5, m0.y - 10, { t: 1210 });
  act = kernel.wmPointer('down', m0.x + 5, m0.y - 10, { t: 1300 });
  check('a third quick click starts over (drag, not activate)', act === 'drag-start', act);
  kernel.wmPointer('up', m0.x + 5, m0.y - 10, { t: 1310 });
  act = kernel.wmPointer('down', m0.x + 5, m0.y - 10, { t: 2000 });
  check('two SLOW clicks never activate', act === 'drag-start', act);
  kernel.wmPointer('up', m0.x + 5, m0.y - 10, { t: 2010 });
  // (x offset 0: >slop from the last down at +5, and still left of the
  // 0030 min box — on this 80px window the boxes start at x+12.)
  act = kernel.wmPointer('down', m0.x, m0.y - 10, { t: 2100 });
  check('quick pair outside the slop still drags', act === 'drag-start', act);
  kernel.wmPointer('up', m0.x, m0.y - 10, { t: 2110 });
  check('double-click leg leaked no app events', drain(ring1).length === 0);

  // ---- second window: z-order, focus, occlusion ----
  const fb2 = makeFb(80, 48);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: fb2.sab, ring: null });
  const c2 = await rpc(appPid, K.OP.SURFACE_CREATE, { w: 80, h: 48, title: 'app two' });
  check('second window focused on create', kernel.wmList().find(s => s.sid === c2.sid).focused);
  present(fb2, [0, 0, 255, 255]);
  // Move window 2 exactly over window 1: topmost wins the composite + hit test.
  kernel.wmMove(c2.sid, moved.x, moved.y);
  screen = kernel.wmScreenshotScreen();
  check('composite honors z-order (top window pixels win)',
    String(px(screen, moved.x + 2, moved.y + 2)) === '0,0,255,255', px(screen, moved.x + 2, moved.y + 2));
  // Same process, one ring: hit test correctness shows in the windowId tag.
  act = kernel.wmPointer('down', moved.x + 10, moved.y + 20, { button: 1 });
  kernel.wmPointer('up', moved.x + 10, moved.y + 20, { button: 1 });
  evs = drain(ring1);
  check('hit test picks the topmost window (windowId tags)',
    evs.length === 2 && evs.every(e => e.win === c2.sid), JSON.stringify(evs));

  // Refocus window 1 -> raises it above window 2.
  kernel.wmFocus(1);
  screen = kernel.wmScreenshotScreen();
  check('wmFocus raises: window 1 pixels on top again',
    String(px(screen, moved.x + 2, moved.y + 2)) === '0,255,0,255', px(screen, moved.x + 2, moved.y + 2));
  check('blurred title bar gray behind', kernel.wmList().find(s => s.sid === c2.sid).focused === false);

  // ---- raise-only focus must bump the scene version (todos/0165) ----
  // wmRestack deliberately doesn't move focus, so lowering the FOCUSED
  // window then focusing it again exercises wmFocus's reorder branch with
  // focus unchanged: z changes, and a version-delta consumer (the damage
  // gate) must see it or it composites a stale stacking order.
  kernel.wmRestack(1, 1);                       // lower window 1; bumps itself
  check('restack-lower leaves focus alone', kernel.wmScene().focusSid === 1);
  const v165 = kernel.wmScene().version;
  kernel.wmFocus(1);                            // raise-only: already focused
  const sc165 = kernel.wmScene();
  check('raise-only focus reorders z (window 1 back on top)',
    sc165.surfaces[sc165.surfaces.length - 1].sid === 1);
  check('raise-only focus bumps the scene version (todos/0165)',
    sc165.version > v165, JSON.stringify([v165, sc165.version]));

  // ---- close box -> SDL_EVENT_QUIT ----
  const w1 = kernel.wmList().find(s => s.sid === 1);
  act = kernel.wmPointer('down', w1.x + w1.w - K.WM_CLOSE_PAD - 2, w1.y - K.WM_TITLE_H + K.WM_CLOSE_PAD + 2, {});
  evs = drain(ring1);
  check('close box posts QUIT', act === 'close' && evs.length === 1 && evs[0].type === K.WMEV.QUIT,
    JSON.stringify([act, evs]));

  // ---- title-bar boxes (todos/0030): [min][max][close], same metrics ----
  // No WM is subscribed here: the MAX box must be a complete no-op (the
  // same R_ERR/no-op as wmctl max — maximize IS policy), and the MIN box
  // must work anyway (minimize is kernel mechanism, focus-fall included).
  const bw1 = kernel.wmList().find(s => s.sid === 1);
  const bxC = bw1.x + bw1.dstW - K.WM_CLOSE_W - K.WM_CLOSE_PAD;
  const bxM = bxC - K.WM_CLOSE_W - K.WM_BOX_GAP;
  const bxN = bxM - K.WM_CLOSE_W - K.WM_BOX_GAP;
  const byB = bw1.y - K.WM_TITLE_H + K.WM_CLOSE_PAD;
  act = kernel.wmPointer('down', bxM + 8, byB + 8, {});
  check('max box with no WM is a no-op', act === 'title-box', act);
  kernel.wmPointer('move', bxM + 50, byB + 60, {});      // a live drag would move it
  check('max box started no drag (window unmoved)',
    kernel.wmList().find(s => s.sid === 1).x === bw1.x &&
    kernel.wmList().find(s => s.sid === 1).y === bw1.y);
  kernel.wmPointer('up', bxM + 50, byB + 60, {});
  check('max box leaked no app events', drain(ring1).length === 0);
  act = kernel.wmPointer('down', bxN + 8, byB + 8, {});
  check('min box minimizes directly (kernel mechanism)', act === 'minimize' &&
    kernel.wmList().find(s => s.sid === 1).minimized === true, act);
  kernel.wmPointer('up', bxN + 8, byB + 8, {});
  check('focus falls off the min-box minimize', kernel.wmScene().focusSid === c2.sid);
  check('min box leaked no app events', drain(ring1).length === 0);
  kernel.wmFocus(1);                                     // restore for later legs
  // Composite: three boxes at the hit-test offsets; flat-rect glyphs (the
  // min bar, the hollow max box) are part of the deterministic composite.
  screen = kernel.wmScreenshotScreen();
  check('composite: three box faces at the expected offsets',
    String(px(screen, bxC + 8, byB + 2)) === '192,192,192,255' &&
    String(px(screen, bxM + 8, byB + 7)) === '192,192,192,255' &&   // hollow center
    String(px(screen, bxN + 8, byB + 4)) === '192,192,192,255',
    JSON.stringify([px(screen, bxC + 8, byB + 2), px(screen, bxM + 8, byB + 7), px(screen, bxN + 8, byB + 4)]));
  check('composite: min bar + max frame glyph pixels',
    String(px(screen, bxN + 5, byB + 14)) === '0,0,0,255' &&
    String(px(screen, bxM + 4, byB + 4)) === '0,0,0,255',
    JSON.stringify([px(screen, bxN + 5, byB + 14), px(screen, bxM + 4, byB + 4)]));

  // ---- agent inject API (targeted, post-hit-test) ----
  kernel.wmInjectKey(1, true, 44, 32, 0);
  kernel.wmInjectPointer(1, 'down', 3, 4, { button: 2 });
  kernel.wmInjectPointer(1, 'wheel', 0, 0, { wheelX: 0, wheelY: -1, direction: 0 });
  evs = drain(ring1);
  check('inject: key/button/wheel all land, targeted at sid 1',
    evs.length === 3 && evs[0].type === K.WMEV.KEYDOWN && evs[1].type === K.WMEV.MOUSEBUTTONDOWN &&
    evs[1].w[2] === 2 && evs[2].type === K.WMEV.MOUSEWHEEL && evs[2].f[1] === -1, JSON.stringify(evs));

  // ---- SET_TITLE ----
  await rpc(appPid, K.OP.SURFACE_SET_TITLE, { sid: 1, title: 'renamed' });
  check('set title', kernel.wmList().find(s => s.sid === 1).title === 'renamed');

  // ---- ring overflow: drop-newest + counter ----
  let lastInject = 0;
  for (let i = 0; i < 300; i++) lastInject = kernel.wmInjectKey(1, true, i, 0, 0);
  check('inject into a full ring reports EAGAIN (todos/0242)', lastInject === 'EAGAIN');
  const dropped = Atomics.load(ring1.i32, K.IR_DROPPED);
  evs = drain(ring1);
  check('overflow drops newest, keeps cap, counts drops',
    evs.length === 256 && dropped === 44 && evs[0].w[0] === 0 && evs[255].w[0] === 255,
    JSON.stringify([evs.length, dropped]));

  // ---- storm (spike S5): 10k events with interleaved drains, integrity ----
  let seen = 0, ok = true;
  for (let i = 0; i < 10000;) {
    const burst = Math.min(200, 10000 - i);
    for (let k = 0; k < burst; k++) kernel.wmInjectKey(1, true, (i + k) & 0x7fffffff, 0, 0);
    i += burst;
    for (const e of drain(ring1)) { if (e.w[0] !== seen++) ok = false; }
  }
  check('10k-event storm: every event delivered in order', ok && seen === 10000, seen);

  // ---- client resize: SURFACE_CONFIGURE renegotiation (todos/0019) ----
  check('wmResize asks the client', kernel.wmResize(1, 96, 80) === 0);
  let s1r = kernel.wmList().find(s => s.sid === 1);
  check('geometry unchanged while pending', s1r.w === 80 && s1r.h === 48 &&
    s1r.configurePending === true, JSON.stringify(s1r));
  let revs = drain(ring1);
  check('WINDOW_RESIZED event in the ring', revs.length === 1 &&
    revs[0].type === K.WMEV.WINDOW_RESIZED && revs[0].win === 1 &&
    revs[0].w[0] === 96 && revs[0].w[1] === 80, JSON.stringify(revs));
  // In-flight old-size frame: legal — lands in the OLD sab, still displayed.
  present(fb1, [255, 255, 0, 255]);
  shot = kernel.wmScreenshot(1);
  check('old-size in-flight frame still shows (old buffer live)',
    shot.w === 80 && String(px(shot, 1, 1)) === '255,255,0,255', px(shot, 1, 1));
  // Bad acks: no SAB handshake; SAB header dims that contradict the RPC.
  const noSab = await rpc(appPid, K.OP.SURFACE_CONFIGURE, { sid: 1, w: 96, h: 80 });
  check('CONFIGURE without a new SAB -> EINVAL', noSab.errno === 'EINVAL');
  workers.get(appPid).msg({ type: 'wm-sabs', fb: makeFb(32, 32).sab, ring: null });
  const badAck = await rpc(appPid, K.OP.SURFACE_CONFIGURE, { sid: 1, w: 96, h: 80 });
  check('CONFIGURE with mismatched SAB dims -> EINVAL', badAck.errno === 'EINVAL');
  // The real ack: first frame at the new size already presented into it.
  const fb1b = makeFb(96, 80);
  present(fb1b, [0, 128, 255, 255]);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: fb1b.sab, ring: null });
  const ackR = await rpc(appPid, K.OP.SURFACE_CONFIGURE, { sid: 1, w: 96, h: 80 });
  check('CONFIGURE ack accepted', !ackR.errno && ackR.w === 96 && ackR.h === 80,
    JSON.stringify(ackR));
  s1r = kernel.wmList().find(s => s.sid === 1);
  check('geometry + pending updated at ack', s1r.w === 96 && s1r.h === 80 &&
    s1r.configurePending === false, JSON.stringify(s1r));
  shot = kernel.wmScreenshot(1);
  check('screenshot reads the swapped buffer', shot.w === 96 && shot.h === 80 &&
    String(px(shot, 90, 70)) === '0,128,255,255', JSON.stringify([shot.w, shot.h]));
  present(fb1, [1, 2, 3, 255]);                       // the abandoned old SAB
  shot = kernel.wmScreenshot(1);
  check('old-buffer flips are ignored after the swap',
    String(px(shot, 1, 1)) === '0,128,255,255', px(shot, 1, 1));
  workers.get(appPid).msg({ type: 'wm-sabs', fb: makeFb(96, 80).sab, ring: null });
  const spont = await rpc(appPid, K.OP.SURFACE_CONFIGURE, { sid: 1, w: 96, h: 80 });
  check('CONFIGURE with nothing pending -> EINVAL (kernel-initiated only)',
    spont.errno === 'EINVAL');

  // ---- superseded resize: latest wins, stale ack accepted + re-asked ----
  kernel.wmResize(1, 120, 90);
  kernel.wmResize(1, 150, 100);
  revs = drain(ring1);
  check('both configure events pushed (latest wins)', revs.length === 2 &&
    revs[0].w[0] === 120 && revs[1].w[0] === 150, JSON.stringify(revs));
  const fbStale = makeFb(120, 90);
  present(fbStale, [9, 9, 9, 255]);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: fbStale.sab, ring: null });
  const staleAck = await rpc(appPid, K.OP.SURFACE_CONFIGURE, { sid: 1, w: 120, h: 90 });
  s1r = kernel.wmList().find(s => s.sid === 1);
  check('stale ack accepted (newer than the old buffer)', !staleAck.errno &&
    s1r.w === 120 && s1r.configurePending === true, JSON.stringify(s1r));
  revs = drain(ring1);
  check('kernel re-asks for the still-pending size', revs.length === 1 &&
    revs[0].type === K.WMEV.WINDOW_RESIZED && revs[0].w[0] === 150 &&
    revs[0].w[1] === 100, JSON.stringify(revs));
  const fbFinal = makeFb(150, 100);
  present(fbFinal, [7, 7, 7, 255]);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: fbFinal.sab, ring: null });
  await rpc(appPid, K.OP.SURFACE_CONFIGURE, { sid: 1, w: 150, h: 100 });
  s1r = kernel.wmList().find(s => s.sid === 1);
  check('final ack settles', s1r.w === 150 && s1r.h === 100 &&
    s1r.configurePending === false, JSON.stringify(s1r));

  // ---- border resize drag: E/S/SE zones, outline preview, one configure ----
  kernel.wmMove(1, 200, 200);
  kernel.wmFocus(1);                                   // topmost for hit tests
  let ract = kernel.wmPointer('down', 200 + 150 + 1, 200 + 100 + 1, {});
  check('SE border mousedown starts a resize drag', ract === 'resize-start', ract);
  ract = kernel.wmPointer('move', 200 + 150 + 41, 200 + 100 + 21, {});
  const rd = kernel.wmScene().resizeDrag;
  check('drag previews only (no configure yet)', ract === 'resize' &&
    drain(ring1).length === 0 && rd && rd.curW === 190 && rd.curH === 120,
    JSON.stringify(rd));
  ract = kernel.wmPointer('up', 200 + 150 + 41, 200 + 100 + 21, {});
  revs = drain(ring1);
  check('release sends ONE configure at the dragged size', ract === 'resize-end' &&
    revs.length === 1 && revs[0].type === K.WMEV.WINDOW_RESIZED &&
    revs[0].w[0] === 190 && revs[0].w[1] === 120, JSON.stringify([ract, revs]));
  const fbDrag = makeFb(190, 120);
  present(fbDrag, [4, 4, 4, 255]);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: fbDrag.sab, ring: null });
  await rpc(appPid, K.OP.SURFACE_CONFIGURE, { sid: 1, w: 190, h: 120 });

  // ---- #388 fat hit zones: the band accepts presses out to WM_BORDER_HIT
  // (invisible slop past the 4px drawn frame), the SE corner widens within
  // WM_GRIP_HIT of it, and the SE grip reaches WM_GRIP_IN into a RESIZABLE
  // client. Releases at the press point resize nothing (curW==baseW), so
  // these probe the boundaries without disturbing the geometry. Window:
  // (200,200) 190x120 -> right edge 390, bottom edge 320.
  ract = kernel.wmPointer('down', 390 + K.WM_BORDER_HIT - 1, 230, {});
  check('#388: press just inside the fat E band starts a drag',
    ract === 'resize-start', ract);
  kernel.wmPointer('up', 390 + K.WM_BORDER_HIT - 1, 230, {});
  ract = kernel.wmPointer('down', 390 + K.WM_BORDER_HIT, 230, {});
  check('#388: one px past the fat band is the desktop', ract === 'desktop', ract);
  kernel.wmPointer('up', 390 + K.WM_BORDER_HIT, 230, {});
  // The focus-only N/W edges keep the thin WM_BORDER band — a fat band
  // there steals the window-behind's title-bar chrome in a cascade.
  ract = kernel.wmPointer('down', 200 - K.WM_BORDER - 1, 230, {});
  check('#388: W band stays thin (one px past WM_BORDER is desktop)',
    ract === 'desktop', ract);
  kernel.wmPointer('up', 200 - K.WM_BORDER - 1, 230, {});
  ract = kernel.wmPointer('down', 250, 200 - K.WM_TITLE_H - K.WM_BORDER - 1, {});
  check('#388: N band stays thin (one px past WM_BORDER is desktop)',
    ract === 'desktop', ract);
  kernel.wmPointer('up', 250, 200 - K.WM_TITLE_H - K.WM_BORDER - 1, {});
  ract = kernel.wmPointer('down', 391, 320 - K.WM_GRIP_HIT + 1, {});
  let rd388 = kernel.wmScene().resizeDrag;
  check('#388: E-band press within WM_GRIP_HIT of the corner widens to SE',
    ract === 'resize-start' && rd388.ex === 1 && rd388.ey === 1,
    JSON.stringify([ract, rd388]));
  kernel.wmPointer('up', 391, 320 - K.WM_GRIP_HIT + 1, {});
  ract = kernel.wmPointer('down', 391, 320 - K.WM_GRIP_HIT - 1, {});
  rd388 = kernel.wmScene().resizeDrag;
  check('#388: above the widened corner stays a width-only E drag',
    ract === 'resize-start' && rd388.ex === 1 && !rd388.ey,
    JSON.stringify([ract, rd388]));
  kernel.wmPointer('up', 391, 320 - K.WM_GRIP_HIT - 1, {});
  ract = kernel.wmPointer('down', 390 - 1, 320 - 1, {});     // inside the client
  rd388 = kernel.wmScene().resizeDrag;
  check('#388: SE grip reaches WM_GRIP_IN into the resizable client',
    ract === 'resize-start' && rd388.ex === 1 && rd388.ey === 1,
    JSON.stringify([ract, rd388]));
  kernel.wmPointer('up', 390 - 1, 320 - 1, {});
  ract = kernel.wmPointer('down', 390 - K.WM_GRIP_IN - 1, 320 - 1, {});
  check('#388: one px left of the inward grip is the client', ract === 'client', ract);
  kernel.wmPointer('up', 390 - K.WM_GRIP_IN - 1, 320 - 1, {});
  ract = kernel.wmPointer('move', 390 - 1, 320 - 1, {});
  check('#388: moves in the inward grip still reach the app (down-only steal)',
    ract === 'client', ract);
  drain(ring1);                                    // the client-leg events
  // The cursor overlay mirrors the hit test (0105 sync rule): NWSE over the
  // inward grip and the widened corner, EW on the fat E band, the client's
  // own cursor (0 = default) just past the grip. CUR_NWSE=5, CUR_EW=7.
  check('#388: cursor overlay agrees with the hit test',
    kernel._wmCursorAt(390 - 1, 320 - 1) === 5 &&
    kernel._wmCursorAt(391, 320 - K.WM_GRIP_HIT + 1) === 5 &&
    kernel._wmCursorAt(390 + K.WM_BORDER_HIT - 1, 230) === 7 &&
    kernel._wmCursorAt(390 - K.WM_GRIP_IN - 1, 320 - 1) === 0,
    JSON.stringify([kernel._wmCursorAt(390 - 1, 320 - 1),
      kernel._wmCursorAt(391, 320 - K.WM_GRIP_HIT + 1),
      kernel._wmCursorAt(390 + K.WM_BORDER_HIT - 1, 230),
      kernel._wmCursorAt(390 - K.WM_GRIP_IN - 1, 320 - 1)]));

  ract = kernel.wmPointer('down', 200 + 190 + 2, 200 + 30, {});   // right border
  check('E border starts a width-only drag', ract === 'resize-start', ract);
  kernel.wmPointer('move', 200 - 500, 200 + 30, {});   // far left: clamps
  const rdE = kernel.wmScene().resizeDrag;
  check('E drag: width tracks (clamped at the floor), height fixed',
    rdE.curW === K.WM_MIN_SIZE && rdE.curH === 120, JSON.stringify(rdE));
  kernel.wmPointer('up', 200 - 500, 200 + 30, {});
  revs = drain(ring1);
  check('clamped configure at release', revs.length === 1 &&
    revs[0].w[0] === K.WM_MIN_SIZE && revs[0].w[1] === 120, JSON.stringify(revs));
  const fbE = makeFb(K.WM_MIN_SIZE, 120);
  present(fbE, [11, 12, 13, 255]);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: fbE.sab, ring: null });
  await rpc(appPid, K.OP.SURFACE_CONFIGURE, { sid: 1, w: K.WM_MIN_SIZE, h: 120 });

  // Left border: focus affordance only (no W/N resize in this version).
  ract = kernel.wmPointer('down', 200 - 2, 200 + 30, {});
  check('left border is focus-only', ract === 'border', ract);
  kernel.wmPointer('up', 200 - 2, 200 + 30, {});

  // The screen composite draws the frame border around the chrome.
  screen = kernel.wmScreenshotScreen();
  check('composite: frame border pixels flank the client',
    String(px(screen, 200 - 2, 200 + 10)) === String(K.WM_COLORS.border) &&
    String(px(screen, 200 + K.WM_MIN_SIZE + 2, 200 + 119)) === String(K.WM_COLORS.border),
    JSON.stringify([px(screen, 198, 210), px(screen, 200 + K.WM_MIN_SIZE + 2, 319)]));

  // wmResize input validation + a dead-ring request leaves nothing pending.
  check('wmResize below the floor is refused: EINVAL', kernel.wmResize(1, 8, 8) === 'EINVAL');
  check('wmResize on a bogus sid is refused: EINVAL', kernel.wmResize(999, 64, 64) === 'EINVAL');

  // ---- SDL_WINDOW_RESIZABLE gating (todos/0021) + viewport scaling
  // (todos/0024): a window created without flags bit2 is fixed-size —
  // wmResize is refused with nothing left pending; its frame drag zones
  // START A SCALE DRAG instead (rubber band; with no WM subscribed the
  // release applies the raw box as the dst rect, buffer untouched) ----
  const fbFix = makeFb(50, 40);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: fbFix.sab, ring: null });
  const cFix = await rpc(appPid, K.OP.SURFACE_CREATE, { w: 50, h: 40, title: 'fixed' });
  check('wmList: no-flags create is not resizable',
    kernel.wmList().find(s => s.sid === cFix.sid).resizable === false);
  check('wmList: bit2 create is resizable',
    kernel.wmList().find(s => s.sid === 1).resizable === true);
  check('create defaults dst to the buffer dims', (() => {
    const s = kernel.wmList().find(s => s.sid === cFix.sid);
    return s.dstW === 50 && s.dstH === 40;
  })());
  check('wmResize on a non-resizable surface is refused: EPERM (todos/0242)',
    kernel.wmResize(cFix.sid, 100, 90) === 'EPERM');
  check('refusal leaves nothing pending, no event to the client',
    kernel.wmList().find(s => s.sid === cFix.sid).configurePending === false &&
    drain(ring1).length === 0);
  kernel.wmMove(cFix.sid, 400, 100);
  kernel.wmFocus(cFix.sid);                            // topmost for hit tests
  // #388: the inward SE grip is RESIZABLE-only — a fixed-size client (games)
  // keeps every client pixel; its scale gesture stays on the outward band.
  let fact = kernel.wmPointer('down', 400 + 50 - 1, 100 + 40 - 1, {});
  check('#388: inward grip does not steal a fixed-size client corner',
    fact === 'client', fact);
  kernel.wmPointer('up', 400 + 50 - 1, 100 + 40 - 1, {});
  drain(ring1);                                        // the client-leg events
  fact = kernel.wmPointer('down', 400 + 50 + 1, 100 + 40 + 1, {});   // SE grip
  check('SE grip on a fixed window starts a SCALE drag (todos/0024)',
    fact === 'resize-start', fact);
  fact = kernel.wmPointer('move', 400 + 50 + 51, 100 + 40 + 41, {});
  const srd = kernel.wmScene().resizeDrag;
  check('scale drag previews only (rubber band, no dst change yet)',
    fact === 'resize' && srd && srd.curW === 100 && srd.curH === 80 &&
    kernel.wmList().find(s => s.sid === cFix.sid).dstW === 50, JSON.stringify(srd));
  fact = kernel.wmPointer('up', 400 + 50 + 51, 100 + 40 + 41, {});
  const scaled = kernel.wmList().find(s => s.sid === cFix.sid);
  check('release applies the raw dst (no-WM fallback): buffer untouched, no client event',
    fact === 'resize-end' && scaled.dstW === 100 && scaled.dstH === 80 &&
    scaled.w === 50 && scaled.h === 40 && scaled.configurePending === false &&
    drain(ring1).length === 0, JSON.stringify(scaled));

  // Scaled composite (2x): nearest-neighbor is exact pixel replication.
  // Present left half red / right half blue into the 50x40 buffer.
  {
    const front = Atomics.load(fbFix.i32, K.SH_FLIP) & 1;
    const back = 1 - front;
    const base = K.SH_HDR_BYTES + back * 50 * 40 * 4;
    for (let y = 0; y < 40; y++) {
      for (let x = 0; x < 50; x++) {
        fbFix.u8.set(x < 25 ? [255, 0, 0, 255] : [0, 0, 255, 255], base + (y * 50 + x) * 4);
      }
    }
    Atomics.store(fbFix.i32, K.SH_FLIP, back);
    Atomics.add(fbFix.i32, K.SH_SEQ, 1);
  }
  screen = kernel.wmScreenshotScreen();
  check('scaled composite: 2x NN left half red', String(px(screen, 400 + 2, 100 + 2)) === '255,0,0,255'
    && String(px(screen, 400 + 49, 100 + 79)) === '255,0,0,255',
    [px(screen, 402, 102), px(screen, 449, 179)]);
  check('scaled composite: 2x NN right half blue at the dst edge',
    String(px(screen, 400 + 50, 100 + 2)) === '0,0,255,255' &&
    String(px(screen, 400 + 99, 100 + 79)) === '0,0,255,255',
    [px(screen, 450, 102), px(screen, 499, 179)]);
  check('chrome tracks the dst rect (frame border past the scaled edge, title bar above)',
    String(px(screen, 400 + 100 + 2, 100 + 40)) === String(K.WM_COLORS.border) &&
    String(px(screen, 400 + 60, 100 - 2)) === String(K.WM_COLORS.titleFocused),
    [px(screen, 502, 140), px(screen, 460, 98)]);

  // Input: hit-testing sees the dst rect; client-bound coords inverse-map
  // to BUFFER coordinates; agent injection stays buffer-coords verbatim.
  fact = kernel.wmPointer('down', 400 + 90, 100 + 60, { button: 1 });   // dst (90,60)
  kernel.wmPointer('up', 400 + 90, 100 + 60, { button: 1 });
  evs = drain(ring1);
  check('client click inside the scaled area inverse-maps (90,60 -> 45,30)',
    fact === 'client' && evs.length === 2 && evs[0].win === cFix.sid &&
    evs[0].f[0] === 45 && evs[0].f[1] === 30, JSON.stringify(evs));
  fact = kernel.wmPointer('move', 400 + 95, 100 + 75, { buttons: 0 });  // beyond the BUFFER, inside the dst
  evs = drain(ring1);
  check('hit test covers the whole dst rect (what you see is what you click)',
    fact === 'client' && evs.length === 1 && evs[0].f[0] === 47.5 && evs[0].f[1] === 37.5,
    JSON.stringify([fact, evs]));
  kernel.wmInjectPointer(cFix.sid, 'down', 3, 4, { button: 1 });
  evs = drain(ring1);
  check('injection stays in buffer coords (post-hit-test, resolution-independent)',
    evs.length === 1 && evs[0].f[0] === 3 && evs[0].f[1] === 4, JSON.stringify(evs));

  // Title-bar boxes respect the dst rect (todos/0030): on the scaled
  // surface the min box sits at dstW-relative offsets, like the close box.
  fact = kernel.wmPointer('down',
    400 + 100 - K.WM_CLOSE_PAD - K.WM_CLOSE_W - 2 * (K.WM_CLOSE_W + K.WM_BOX_GAP) + 8,
    100 - K.WM_TITLE_H + K.WM_CLOSE_PAD + 8, {});
  check('min box hits at the SCALED offsets (dst rect)', fact === 'minimize' &&
    kernel.wmList().find(s => s.sid === cFix.sid).minimized === true, fact);
  kernel.wmPointer('up', 452, 88, {});
  kernel.wmFocus(cFix.sid);                              // restore (un-minimizes)
  drain(ring1);

  // wmSetDst validation: resizable surfaces refuse (they configure), floors/
  // caps like wmResize, bogus sids refuse.
  check('wmSetDst on a RESIZABLE surface is refused: EPERM', kernel.wmSetDst(1, 200, 100) === 'EPERM');
  check('wmSetDst below the floor is refused: EINVAL', kernel.wmSetDst(cFix.sid, 8, 8) === 'EINVAL');
  check('wmSetDst on a bogus sid is refused: EINVAL', kernel.wmSetDst(999, 64, 64) === 'EINVAL');

  // The wmSetScreen one-shot clamp (todos/0023) measures the SCALED size.
  kernel.wmMove(cFix.sid, -90, 100);       // dst is 100 wide: floor is 40-100
  kernel.wmSetScreen(632, 480);
  check('screen clamp uses the dst width (x -> 40 - dstW)',
    kernel.wmList().find(s => s.sid === cFix.sid).x === -60,
    kernel.wmList().find(s => s.sid === cFix.sid).x);
  kernel.wmSetScreen(640, 480);
  kernel.wmMove(cFix.sid, 400, 100);

  // SET_FLAGS bit2 grants resizability at runtime (and the zones light up);
  // the grant snaps the viewport back to the buffer — resizable and scaled
  // are exclusive modes (todos/0024).
  await rpc(appPid, K.OP.SURFACE_SET_FLAGS, { sid: cFix.sid, flags: 4 });
  check('SET_FLAGS bit2 makes it resizable',
    kernel.wmList().find(s => s.sid === cFix.sid).resizable === true);
  check('the grant resets dst to the buffer (exclusive modes)', (() => {
    const s = kernel.wmList().find(s => s.sid === cFix.sid);
    return s.dstW === 50 && s.dstH === 40;
  })());
  fact = kernel.wmPointer('down', 400 + 50 + 1, 100 + 40 + 1, {});
  check('SE grip works after the grant', fact === 'resize-start', fact);
  kernel.wmPointer('up', 400 + 50 + 1, 100 + 40 + 1, {});   // no-move: no configure
  check('wmResize works after the grant', kernel.wmResize(cFix.sid, 60, 50) === 0);
  drain(ring1);                                        // its WINDOW_RESIZED
  await rpc(appPid, K.OP.SURFACE_DESTROY, { sid: cFix.sid });
  kernel.wmFocus(1);                                   // restore for later legs

  // ---- relative mouse / pointer lock (todos/0018) ----
  // SET_FLAGS validation, the wanted-state round trip, rel-record injection,
  // and locked vs unlocked routing. sid 1 is focused here.
  const badFlags = await rpc(appPid, K.OP.SURFACE_SET_FLAGS, { sid: 999, flags: 2 });
  check('SET_FLAGS on a bogus sid -> EINVAL', badFlags.errno === 'EINVAL');
  check('no pointer-lock events yet', ptrLockEvents.length === 0, JSON.stringify(ptrLockEvents));
  const setF = await rpc(appPid, K.OP.SURFACE_SET_FLAGS, { sid: 1, flags: 2 });
  check('SET_FLAGS bit1 sets relativeMouse', !setF.errno &&
    kernel.wmList().find(s => s.sid === 1).relativeMouse === true);
  check('focused relative surface -> onPointerLock(true)',
    ptrLockEvents.length === 1 && ptrLockEvents[0] === true, JSON.stringify(ptrLockEvents));
  check('wmScene exposes the wanted state', kernel.wmScene().pointerLockWanted === true);

  // Injection: rel records carry deltas + the relative flag (word [5]).
  kernel.wmInjectPointer(1, 'rel', 5, -3, { buttons: 1 });
  evs = drain(ring1);
  check('inject rel: MOUSEMOTION with deltas + rel flag', evs.length === 1 &&
    evs[0].type === K.WMEV.MOUSEMOTION && evs[0].f[0] === 5 && evs[0].f[1] === -3 &&
    evs[0].w[2] === 1 && evs[0].w[3] === 1, JSON.stringify(evs));

  // Not locked yet: bridge motion still routes by hit test (desktop misses).
  check('unlocked motion still hit-tests', kernel.wmPointer('move', 5, 5, { buttons: 0 }) === 'desktop');

  // Lock reported by the bridge: EVERYTHING routes to the focused surface.
  kernel.wmPointerLockChanged(true);
  let lact = kernel.wmPointer('move', 5, 5, { dx: 7, dy: -2, buttons: 0 });
  evs = drain(ring1);
  check('locked motion -> rel record to the focused surface (no hit test)',
    lact === 'locked' && evs.length === 1 && evs[0].win === 1 &&
    evs[0].type === K.WMEV.MOUSEMOTION && evs[0].f[0] === 7 && evs[0].f[1] === -2 &&
    evs[0].w[3] === 1, JSON.stringify([lact, evs]));
  const lw = kernel.wmList().find(s => s.sid === 1);
  lact = kernel.wmPointer('down', 5, 5, { button: 1 });
  evs = drain(ring1);
  check('locked button -> focused surface at the client center',
    lact === 'locked' && evs.length === 1 && evs[0].type === K.WMEV.MOUSEBUTTONDOWN &&
    evs[0].win === 1 && evs[0].f[0] === lw.w / 2 && evs[0].f[1] === lw.h / 2,
    JSON.stringify([lact, evs]));

  // Unlock (the browser ESC path): absolute routing returns — the window is
  // draggable/closable again (the 0018 acceptance line).
  kernel.wmPointerLockChanged(false);
  check('unlocked motion hit-tests again', kernel.wmPointer('move', 5, 5, { buttons: 0 }) === 'desktop');
  const dw = kernel.wmList().find(s => s.sid === 1);
  kernel.wmPointer('down', dw.x + 5, dw.y - 10, {});
  kernel.wmPointer('move', dw.x + 15, dw.y - 5, {});
  kernel.wmPointer('up', dw.x + 15, dw.y - 5, {});
  const dw2 = kernel.wmList().find(s => s.sid === 1);
  check('window drags while unlocked', dw2.x === dw.x + 10 && dw2.y === dw.y + 5,
    JSON.stringify([dw.x, dw.y, dw2.x, dw2.y]));
  drain(ring1);

  // Focus moving to a non-relative surface withdraws the wanted state (and
  // kills active routing even if the bridge report races).
  kernel.wmPointerLockChanged(true);
  kernel.wmFocus(c2.sid);
  check('focus to a non-relative surface -> onPointerLock(false)',
    ptrLockEvents.length === 2 && ptrLockEvents[1] === false, JSON.stringify(ptrLockEvents));
  check('active routing dropped with the wanted state',
    kernel.wmPointer('move', 5, 5, { dx: 1, dy: 1 }) === 'desktop');
  drain(ring1);

  // Focus back -> wanted again; minimize -> withdrawn again.
  kernel.wmFocus(1);
  check('refocus re-wants the lock', ptrLockEvents.length === 3 && ptrLockEvents[2] === true);
  kernel.wmMinimize(1);
  check('minimize withdraws the lock', ptrLockEvents.length === 4 && ptrLockEvents[3] === false);
  kernel.wmFocus(1);                                    // restore for later legs
  check('restore re-wants the lock', ptrLockEvents.length === 5 && ptrLockEvents[4] === true);

  // The lock gesture: a client click on the focused relative-mouse surface
  // RE-OFFERS wanted=true (the bridge requests the lock inside the click's
  // transient activation). Title clicks must not — dragging stays intact.
  const cw = kernel.wmList().find(s => s.sid === 1);
  kernel.wmPointer('down', cw.x + 5, cw.y + 5, { button: 1 });
  kernel.wmPointer('up', cw.x + 5, cw.y + 5, { button: 1 });
  check('client click re-offers the lock (the gesture path)',
    ptrLockEvents.length === 6 && ptrLockEvents[5] === true, JSON.stringify(ptrLockEvents));
  kernel.wmPointer('down', cw.x + 5, cw.y - 10, {});    // title: drag-start
  kernel.wmPointer('up', cw.x + 5, cw.y - 10, {});
  check('title click does NOT re-offer', ptrLockEvents.length === 6);
  kernel.wmPointerLockChanged(true);                    // lock taken:
  kernel.wmPointer('down', cw.x + 5, cw.y + 5, { button: 1 });
  check('locked client click does not re-offer', ptrLockEvents.length === 6);
  kernel.wmPointerLockChanged(false);
  drain(ring1);

  // Clearing the flag withdraws it; creating WITH bit1 set wants it at birth.
  await rpc(appPid, K.OP.SURFACE_SET_FLAGS, { sid: 1, flags: 0 });
  check('SET_FLAGS clearing bit1 -> onPointerLock(false)',
    ptrLockEvents.length === 7 && ptrLockEvents[6] === false &&
    kernel.wmList().find(s => s.sid === 1).relativeMouse === false);
  const fbRel = makeFb(40, 30);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: fbRel.sab, ring: null });
  const cRel = await rpc(appPid, K.OP.SURFACE_CREATE, { w: 40, h: 30, title: 'rel', flags: 2 });
  check('CREATE with flags bit1 wants the lock at birth', !cRel.errno &&
    ptrLockEvents.length === 8 && ptrLockEvents[7] === true);
  // Destroying the focused relative surface withdraws it (lifecycle sync).
  await rpc(appPid, K.OP.SURFACE_DESTROY, { sid: cRel.sid });
  check('destroy withdraws the lock', ptrLockEvents.length === 9 && ptrLockEvents[8] === false);
  drain(ring1);

  // ---- lifecycle: normal exit reclaims surfaces ----
  workers.get(appPid).msg({ type: 'exited', code: 0 });
  await tick();
  check('exit reclaims surfaces + focus clears', kernel.wmList().length === 0 && kernel.wmScene().focusSid === 0,
    JSON.stringify(kernel.wmList()));
  await rpc(1, K.OP.WAIT, { pid: -1, options: 0 });

  // ---- lifecycle: SIGKILL reclaims surfaces ----
  const r2 = await rpc(1, K.OP.SPAWN, { path: '/bin/app', argv: ['app'], envp: [], actions: [], flags: 0 });
  const fb3 = makeFb(32, 32);
  workers.get(r2.pid).msg({ type: 'wm-sabs', fb: fb3.sab, ring: makeRing(64).sab });
  await rpc(r2.pid, K.OP.SURFACE_CREATE, { w: 32, h: 32, title: 'doomed' });
  check('window up before kill', kernel.wmList().length === 1);
  kernel.kill(r2.pid, 9, null);
  check('SIGKILL leaves no ghost windows', kernel.wmList().length === 0);
  check('worker terminated', workers.get(r2.pid).terminated === true);
  // Reaps below are WNOHANG (options 1): each zombie is guaranteed by the
  // checks just above it, and a blocking WAIT would HANG the file instead
  // of failing loud if a regression left the child alive (0171 discipline).
  await rpc(1, K.OP.WAIT, { pid: -1, options: 1 });

  // ---- hung-app containment (#486): ignored close request -> force quit ----
  // Kernel constructed with hungGraceMs: 300 (poll = grace/4 = 75ms); each
  // wait below is grace + a few polls of slack, no fixed-sleep sync — the
  // watchdog deadline IS the thing under test, so a clock wait is the spec.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const r3 = await rpc(1, K.OP.SPAWN, { path: '/bin/app', argv: ['app'], envp: [], actions: [], flags: 0 });
  const fbH = makeFb(48, 32);
  const ringH = makeRing(64);
  workers.get(r3.pid).msg({ type: 'wm-sabs', fb: fbH.sab, ring: ringH.sab });
  const cH = await rpc(r3.pid, K.OP.SURFACE_CREATE, { w: 48, h: 32, title: 'wedged' });
  // The app NEVER drains its ring. Close through the real chrome path.
  const hw = kernel.wmList().find((s) => s.sid === cH.sid);
  act = kernel.wmPointer('down', hw.x + hw.dstW - K.WM_CLOSE_PAD - 2,
                         hw.y - K.WM_TITLE_H + K.WM_CLOSE_PAD + 2, {});
  check('close box on the wedged app requests close', act === 'close', act);
  check('still running inside the grace period', kernel.process(r3.pid).state === 'running');
  await sleep(700);
  check('hung app force-quit within grace (zombie)',
    kernel.process(r3.pid) && kernel.process(r3.pid).state === 'zombie');
  check('hung app: surfaces reclaimed', !kernel.wmList().some((s) => s.sid === cH.sid));
  check('hung app: worker terminated', workers.get(r3.pid).terminated === true);
  check('legible reason emitted (title + "not responding")',
    logLines.some((m) => m.includes('"wedged"') && m.includes('is not responding') &&
                         m.includes('force quit')),
    JSON.stringify(logLines));
  await rpc(1, K.OP.WAIT, { pid: -1, options: 1 });

  // A responsive app — one that PUMPS the close request, whatever it then
  // decides — is never touched by the watchdog (the acceptance's second leg).
  const r4 = await rpc(1, K.OP.SPAWN, { path: '/bin/app', argv: ['app'], envp: [], actions: [], flags: 0 });
  const fbR = makeFb(48, 32);
  const ringR = makeRing(64);
  workers.get(r4.pid).msg({ type: 'wm-sabs', fb: fbR.sab, ring: ringR.sab });
  const cR = await rpc(r4.pid, K.OP.SURFACE_CREATE, { w: 48, h: 32, title: 'polite' });
  const logsBefore = logLines.length;
  check('CLOSE_REQ path delivers', kernel.wmCloseRequest(cR.sid) === 0);
  evs = drain(ringR);                       // the app pumps: QUIT consumed
  check('polite app received the QUIT', evs.some((e) => e.type === K.WMEV.QUIT),
    JSON.stringify(evs));
  await sleep(700);
  check('responsive app never touched by the watchdog',
    kernel.process(r4.pid).state === 'running' && logLines.length === logsBefore,
    JSON.stringify([kernel.process(r4.pid).state, logLines.slice(logsBefore)]));

  // Second close during grace with the first QUIT still unconsumed (the app
  // stopped pumping): Windows-style escalation — force-quit immediately.
  check('re-close after consumption is a fresh request', kernel.wmCloseRequest(cR.sid) === 0);
  check('second close during grace force-quits immediately',
    kernel.wmCloseRequest(cR.sid) === 0 && kernel.process(r4.pid).state === 'zombie');
  check('escalation emitted the reason',
    logLines.length === logsBefore + 1 && logLines[logsBefore].includes('"polite"'),
    JSON.stringify(logLines.slice(logsBefore)));
  await rpc(1, K.OP.WAIT, { pid: -1, options: 1 });

  // Full ring at request time (EAGAIN — the strongest not-draining signal):
  // the watchdog arms anyway, retries delivery each poll, and the grace
  // clock starts at the click.
  const r5 = await rpc(1, K.OP.SPAWN, { path: '/bin/app', argv: ['app'], envp: [], actions: [], flags: 0 });
  const fbF = makeFb(48, 32);
  const ringF = makeRing(8);
  workers.get(r5.pid).msg({ type: 'wm-sabs', fb: fbF.sab, ring: ringF.sab });
  const cF = await rpc(r5.pid, K.OP.SURFACE_CREATE, { w: 48, h: 32, title: 'flooded' });
  for (let i = 0; i < 10; i++) kernel.wmInjectKey(cF.sid, true, 4, 97, 0);
  check('flooded ring: close request reports EAGAIN', kernel.wmCloseRequest(cF.sid) === 'EAGAIN');
  await sleep(700);
  check('undeliverable close still force-quits at the deadline',
    kernel.process(r5.pid).state === 'zombie');
  check('flooded reason emitted', logLines.some((m) => m.includes('"flooded"')),
    JSON.stringify(logLines));
  await rpc(1, K.OP.WAIT, { pid: -1, options: 1 });

  console.log(failures ? `\ntest_wm: ${failures} FAILED` : '\ntest_wm: all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
