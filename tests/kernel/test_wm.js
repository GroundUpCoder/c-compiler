#!/usr/bin/env node
// WM surface semantics (todos/WM.md, todos/0007) without wasm: fake workers
// over a brokered kernel, the test playing the process side of the kernel-
// page protocol (test_sockets.js pattern). Covers: SURFACE_CREATE handshake
// (SABs precede the RPC on the same FIFO channel), mailbox present + kernel
// screenshots, the screen composite with kernel chrome, input routing (focus,
// hit-test, title drag, close box), the agent inject API, input-ring overflow
// + a storm (spike S5), and lifecycle cleanup on exit and SIGKILL.
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
const kernel = new K.Kernel({
  fs: kfs,
  createWorker,
  loadImage: (p) => images.get(p) || null,
  onHalt: () => {},
  log: () => {},
  screen: { w: 640, h: 480 },
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
  return out;
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

  const fb1 = makeFb(64, 48);
  const ring1 = makeRing(256);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: fb1.sab, ring: ring1.sab });
  const c1 = await rpc(appPid, K.OP.SURFACE_CREATE, { w: 64, h: 48, title: 'app one' });
  check('create -> sid 1', c1.sid === 1, JSON.stringify(c1));
  check('placement below the title bar', c1.y >= K.WM_TITLE_H, c1.y);

  const wrong = makeFb(16, 16);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: wrong.sab, ring: null });
  const badDim = await rpc(appPid, K.OP.SURFACE_CREATE, { w: 32, h: 32, title: 'x' });
  check('create with mismatched fb dims -> EINVAL', badDim.errno === 'EINVAL');

  let list = kernel.wmList();
  check('wmList has the window, focused', list.length === 1 && list[0].sid === 1 &&
    list[0].focused && list[0].title === 'app one', JSON.stringify(list));

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

  // ---- second window: z-order, focus, occlusion ----
  const fb2 = makeFb(64, 48);
  workers.get(appPid).msg({ type: 'wm-sabs', fb: fb2.sab, ring: null });
  const c2 = await rpc(appPid, K.OP.SURFACE_CREATE, { w: 64, h: 48, title: 'app two' });
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

  // ---- close box -> SDL_EVENT_QUIT ----
  const w1 = kernel.wmList().find(s => s.sid === 1);
  act = kernel.wmPointer('down', w1.x + w1.w - K.WM_CLOSE_PAD - 2, w1.y - K.WM_TITLE_H + K.WM_CLOSE_PAD + 2, {});
  evs = drain(ring1);
  check('close box posts QUIT', act === 'close' && evs.length === 1 && evs[0].type === K.WMEV.QUIT,
    JSON.stringify([act, evs]));

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
  for (let i = 0; i < 300; i++) kernel.wmInjectKey(1, true, i, 0, 0);
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
  check('wmResize asks the client', kernel.wmResize(1, 96, 80) === true);
  let s1r = kernel.wmList().find(s => s.sid === 1);
  check('geometry unchanged while pending', s1r.w === 64 && s1r.h === 48 &&
    s1r.configurePending === true, JSON.stringify(s1r));
  let revs = drain(ring1);
  check('WINDOW_RESIZED event in the ring', revs.length === 1 &&
    revs[0].type === K.WMEV.WINDOW_RESIZED && revs[0].win === 1 &&
    revs[0].w[0] === 96 && revs[0].w[1] === 80, JSON.stringify(revs));
  // In-flight old-size frame: legal — lands in the OLD sab, still displayed.
  present(fb1, [255, 255, 0, 255]);
  shot = kernel.wmScreenshot(1);
  check('old-size in-flight frame still shows (old buffer live)',
    shot.w === 64 && String(px(shot, 1, 1)) === '255,255,0,255', px(shot, 1, 1));
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
  check('wmResize below the floor is refused', kernel.wmResize(1, 8, 8) === false);
  check('wmResize on a bogus sid is refused', kernel.wmResize(999, 64, 64) === false);

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

  console.log(failures ? `\ntest_wm: ${failures} FAILED` : '\ntest_wm: all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
