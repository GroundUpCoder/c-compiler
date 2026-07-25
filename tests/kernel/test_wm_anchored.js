#!/usr/bin/env node
// Anchored child surfaces + the grab + the focus funnel (todos/0256, the
// menu-uniform architecture's Spike 1) without wasm: fake workers over a
// brokered kernel (the test_wm.js pattern). Covers, at the kernel seam:
//   - SURFACE_CREATE flag bit6 validation (parent exists, same pid), the
//     materialized child rect (A11), the grab-gated into-the-screen clamp
//     (grabbed = transient menu, slides to stay reachable; non-grab =
//     structural attachment, rigidly tracks the parent and clips at the
//     viewport like client pixels), and no-focus-steal-at-create
//   - move-with-parent through wmMove + the title drag (recursive over a
//     2-level chain, A1), scale inheritance under wmSetDst, the A5
//     owner-initiated child resize (SURFACE_RESIZE + CONFIGURE re-derive)
//   - hide/show with the parent in the hit test + headless composite, the
//     group fly (wmScene keeps an anchor-hidden subtree + marks animRootSid
//     while the root's minimize/restore fly is live — the one sanctioned
//     anchor-blind exception), raise-as-subtree z re-slotting, WM-op
//     refusal (EPERM) on children,
//     click/wmFocus redirect to the anchor root, destroy cascade (whole
//     tree AND mid-tree), thumbnail child compositing (A10)
//   - the grab (A2): press outside the holder's window tree -> QUIT to the
//     holder + press AND release consumed + grab released; presses inside
//     the tree route; pointer lock outranks the grab; per-window injection
//     bypasses it (post-hit-test by design)
//   - the focus funnel (A9): the owner FOCUS_GAINED/LOST pair at ALL three
//     transitions — create-steal, wmFocus, and the minimize/destroy fall
//
// Run: node tests/kernel/test_wm_anchored.js
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

// ---- fake worker plumbing (test_wm.js shape) ----
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
  onPointerLock: () => {},
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
    out.push({ type: ring.i32[base], win: ring.i32[base + 1] });
    rpos = (rpos + 1) % cap2;
    Atomics.store(ring.i32, K.IR_RPOS, rpos);
  }
  return out;
}
const px = (shot, x, y) => Array.from(shot.rgba.subarray((y * shot.w + x) * 4, (y * shot.w + x) * 4 + 4));
const byTitle = (t) => kernel.wmList().find((w) => w.title === t);
const has = (evs, type, win) => evs.some((e) => e.type === type && (win === undefined || e.win === win));
const FOCUS_GAINED = K.WMEV.FOCUS_GAINED, FOCUS_LOST = K.WMEV.FOCUS_LOST,
      QUIT = K.WMEV.QUIT, BTN_DOWN = K.WMEV.MOUSEBUTTONDOWN;

(async () => {
  await kernel.boot({ path: '/bin/init' });
  const a = (await rpc(1, K.OP.SPAWN, { path: '/bin/app', argv: ['a'], envp: [], actions: [], flags: 0 })).pid;
  const b = (await rpc(1, K.OP.SPAWN, { path: '/bin/app', argv: ['b'], envp: [], actions: [], flags: 0 })).pid;

  // ---- process A: fixed-size parent P at a known spot ----
  const fbP = makeFb(100, 80);
  const ringA = makeRing(256);
  workers.get(a).msg({ type: 'wm-sabs', fb: fbP.sab, ring: ringA.sab });
  const cP = await rpc(a, K.OP.SURFACE_CREATE, { w: 100, h: 80, title: 'pa', flags: 0 });
  check('parent created', cP.sid > 0, JSON.stringify(cP));
  kernel.wmMove(cP.sid, 200, 100);
  drain(ringA);   // discard create-time events for now (funnel legs below)

  // ---- create validation ----
  const wrongParent = makeFb(30, 20);
  workers.get(a).msg({ type: 'wm-sabs', fb: wrongParent.sab, ring: null });
  const badP = await rpc(a, K.OP.SURFACE_CREATE, { w: 30, h: 20, title: 'x', flags: 64, parentSid: 999, dx: 0, dy: 0 });
  check('anchored create with unknown parent -> EINVAL', badP.errno === 'EINVAL', JSON.stringify(badP));

  // ---- child + grandchild (A1 tree) ----
  const fbC1 = makeFb(30, 20);
  workers.get(a).msg({ type: 'wm-sabs', fb: fbC1.sab, ring: null });
  const cC1 = await rpc(a, K.OP.SURFACE_CREATE, { w: 30, h: 20, title: 'c1', flags: 64, parentSid: cP.sid, dx: 10, dy: 20 });
  check('child created at parent + offset', cC1.sid > 0 && cC1.x === 210 && cC1.y === 120, JSON.stringify(cC1));
  const fbC2 = makeFb(10, 10);
  workers.get(a).msg({ type: 'wm-sabs', fb: fbC2.sab, ring: null });
  const cC2 = await rpc(a, K.OP.SURFACE_CREATE, { w: 10, h: 10, title: 'c2', flags: 64, parentSid: cC1.sid, dx: 5, dy: 5 });
  check('grandchild (child-of-child) accepted — A1 arbitrary depth',
    cC2.sid > 0 && cC2.x === 215 && cC2.y === 125, JSON.stringify(cC2));
  check('children are implicitly borderless + flagged anchored',
    byTitle('c1').borderless && byTitle('c1').parent === cP.sid &&
    byTitle('c2').parent === cC1.sid, JSON.stringify(byTitle('c1')));
  check('no focus steal at create — parent keeps focus',
    byTitle('pa').focused === true, JSON.stringify(kernel.wmList().map((w) => [w.title, w.focused])));

  // cross-pid parent refused (B may not anchor to A's window)
  // NB the FIRST ring a process posts is the one the kernel keeps — install
  // B's real ring here.
  const ringB = makeRing(256);
  const fbBx = makeFb(30, 20);
  workers.get(b).msg({ type: 'wm-sabs', fb: fbBx.sab, ring: ringB.sab });
  const badX = await rpc(b, K.OP.SURFACE_CREATE, { w: 30, h: 20, title: 'x', flags: 64, parentSid: cP.sid, dx: 0, dy: 0 });
  check('cross-pid parent -> EINVAL', badX.errno === 'EINVAL', JSON.stringify(badX));

  // ---- move with parent: wmMove + title drag, recursive ----
  kernel.wmMove(cP.sid, 240, 140);
  check('wmMove carries the subtree', byTitle('c1').x === 250 && byTitle('c1').y === 160 &&
    byTitle('c2').x === 255 && byTitle('c2').y === 165,
    JSON.stringify([byTitle('c1'), byTitle('c2')].map((w) => [w.x, w.y])));
  // interactive title drag: press mid-title, move +20/+10, release
  check('title drag starts', kernel.wmPointer('down', 260, 130, {}) === 'drag-start');
  kernel.wmPointer('move', 280, 140, {});
  kernel.wmPointer('up', 280, 140, {});
  check('title drag carries the subtree', byTitle('pa').x === 260 && byTitle('pa').y === 150 &&
    byTitle('c1').x === 270 && byTitle('c1').y === 170 && byTitle('c2').x === 275 && byTitle('c2').y === 175,
    JSON.stringify([byTitle('pa'), byTitle('c1'), byTitle('c2')].map((w) => [w.x, w.y])));
  kernel.wmMove(cP.sid, 200, 100);   // back to the canonical spot

  // ---- WM ops refuse children (policy never manages popups) ----
  check('wmMove on a child -> EPERM', kernel.wmMove(cC1.sid, 0, 0) === 'EPERM');
  check('wmSetLayer on a child -> EPERM', kernel.wmSetLayer(cC1.sid, 1) === 'EPERM');
  check('wmMinimize on a child -> EPERM', kernel.wmMinimize(cC1.sid) === 'EPERM');
  check('wmRestack on a child -> EPERM', kernel.wmRestack(cC1.sid, 0) === 'EPERM');
  check('wmSetDst on a child -> EPERM', kernel.wmSetDst(cC1.sid, 60, 40) === 'EPERM');
  check('wmResize on a child -> EPERM', kernel.wmResize(cC1.sid, 50, 30) === 'EPERM');

  // ---- scale inheritance (A11 materialization) ----
  check('wmSetDst on the parent accepted', kernel.wmSetDst(cP.sid, 200, 160) === 0);
  check('child dst rides the parent scale (2x)',
    byTitle('c1').x === 220 && byTitle('c1').y === 140 &&
    byTitle('c1').dstW === 60 && byTitle('c1').dstH === 40,
    JSON.stringify(byTitle('c1')));
  check('grandchild compounds through the chain',
    byTitle('c2').x === 230 && byTitle('c2').y === 150 &&
    byTitle('c2').dstW === 20 && byTitle('c2').dstH === 20,
    JSON.stringify(byTitle('c2')));
  kernel.wmSetDst(cP.sid, 100, 80);

  // ---- into-the-screen clamp is GRAB-GATED (screen 640x480) ----
  // A grabbed child is a transient menu: it slides into the screen (it must
  // stay reachable to be clickable).
  const fbFar = makeFb(30, 20);
  workers.get(a).msg({ type: 'wm-sabs', fb: fbFar.sab, ring: null });
  const cFar = await rpc(a, K.OP.SURFACE_CREATE, { w: 30, h: 20, title: 'far', flags: 64 | 128, parentSid: cP.sid, dx: 5000, dy: 10 });
  check('grabbed child clamps into the screen at create', cFar.x === 610 && cFar.y === 110, JSON.stringify(cFar));
  kernel.wmMove(cP.sid, 100, 100);
  check('clamp re-derives on parent move (never accumulates)',
    byTitle('far').x === 610 && byTitle('far').y === 110, JSON.stringify(byTitle('far')));
  await rpc(a, K.OP.SURFACE_DESTROY, { sid: cFar.sid });   // releases its grab
  kernel.wmMove(cP.sid, 200, 100);
  // A non-grab child is a structural attachment (a menu-bar strip): it
  // rigidly tracks the parent and clips at the viewport edge like the
  // parent's own client pixels — never slid off its window frame.
  const fbRig = makeFb(30, 20);
  workers.get(a).msg({ type: 'wm-sabs', fb: fbRig.sab, ring: null });
  const cRig = await rpc(a, K.OP.SURFACE_CREATE, { w: 30, h: 20, title: 'rig', flags: 64, parentSid: cP.sid, dx: 5000, dy: 10 });
  check('non-grab child is NOT clamped (rigid attachment)',
    cRig.x === 5200 && cRig.y === 110, JSON.stringify(cRig));
  kernel.wmMove(cP.sid, 100, 100);
  check('non-grab child rigidly tracks the parent off-screen',
    byTitle('rig').x === 5100 && byTitle('rig').y === 110, JSON.stringify(byTitle('rig')));
  await rpc(a, K.OP.SURFACE_DESTROY, { sid: cRig.sid });
  kernel.wmMove(cP.sid, 200, 100);

  // ---- second process window Q; z re-slot + focus redirect ----
  const fbQ = makeFb(100, 80);
  workers.get(b).msg({ type: 'wm-sabs', fb: fbQ.sab, ring: null });
  const cQ = await rpc(b, K.OP.SURFACE_CREATE, { w: 100, h: 80, title: 'qb', flags: 0 });
  kernel.wmMove(cQ.sid, 450, 300);
  const zOrder = () => kernel.wmList().map((w) => w.title).join(',');
  check('creating Q leaves the subtree contiguous', zOrder() === 'pa,c1,c2,qb', zOrder());
  kernel.wmFocus(cP.sid);
  check('raise-as-subtree: focus P re-slots children directly above it',
    zOrder() === 'qb,pa,c1,c2', zOrder());
  check('wmFocus on a child redirects to the root', kernel.wmFocus(cQ.sid) === 0 &&
    kernel.wmFocus(cC2.sid) === 0 && byTitle('pa').focused === true, zOrder());

  // ---- click on a child focuses the anchor root ----
  kernel.wmFocus(cQ.sid);
  drain(ringA); drain(ringB);
  const hit = kernel.wmPointer('down', 212, 122, {});   // inside c1's client (clear of c2)
  kernel.wmPointer('up', 212, 122, {});
  check('child client click routes to the child', hit === 'client');
  check('...delivers to the child surface', has(drain(ringA), BTN_DOWN, cC1.sid));
  check('...and focuses the PARENT, not the child', byTitle('pa').focused === true &&
    byTitle('c1').parent === cP.sid, JSON.stringify(kernel.wmList().map((w) => [w.title, w.focused])));

  // ---- hide/show with parent: composite + hit test ----
  present(fbP, [255, 0, 0, 255]);
  present(fbC1, [0, 255, 0, 255]);
  present(fbC2, [0, 0, 255, 255]);
  let shot = kernel.wmScreenshotScreen();
  check('composite shows child pixels over the parent',
    String(px(shot, 212, 122)) === '0,255,0,255' && String(px(shot, 217, 127)) === '0,0,255,255',
    [px(shot, 212, 122), px(shot, 217, 127)].join(' | '));
  kernel.wmMinimize(cP.sid);
  shot = kernel.wmScreenshotScreen();
  check('minimizing the parent hides the whole subtree',
    String(px(shot, 212, 122)) !== '0,255,0,255' && String(px(shot, 217, 127)) !== '0,0,255,255',
    [px(shot, 212, 122), px(shot, 217, 127)].join(' | '));
  check('hidden children leave the hit test', kernel.wmPointer('down', 212, 122, {}) === 'desktop');
  kernel.wmPointer('up', 212, 122, {});
  // Group fly (the ONE anchor-blind exception): while the root's minimize
  // fly is live, the scene KEEPS the anchor-hidden subtree and marks each
  // child with animRootSid, so the compositor rides the whole group along
  // the fly. Re-stamp t0 (deterministic — no wall-clock dependence under
  // load), then rewind it to expire the fly.
  kernel._wmAnims.get(cP.sid).t0 = Date.now();
  let scn = kernel.wmScene();
  const sceneSid = (sc, sid) => sc.surfaces.find((s) => s.sid === sid);
  check('scene keeps children during the live min fly (group fly)',
    !!sceneSid(scn, cC1.sid) && !!sceneSid(scn, cC2.sid) &&
    sceneSid(scn, cC1.sid).animRootSid === cP.sid &&
    sceneSid(scn, cC2.sid).animRootSid === cP.sid,
    JSON.stringify(scn.surfaces.map((s) => [s.title, s.animRootSid])));
  kernel._wmAnims.get(cP.sid).t0 -= 100000;   // expire the fly
  check('scene excludes hidden children once the fly expires',
    !kernel.wmScene().surfaces.some((s) => s.sid === cC1.sid), JSON.stringify(kernel.wmScene().surfaces.map((s) => s.title)));
  kernel.wmFocus(cP.sid);   // restore
  // Restore direction: children are visible anyway (minimized cleared
  // before the restore push) — the scene only adds the fly linkage.
  kernel._wmAnims.get(cP.sid).t0 = Date.now();
  scn = kernel.wmScene();
  check('restore-direction children carry the group-fly linkage',
    sceneSid(scn, cC1.sid).animRootSid === cP.sid &&
    sceneSid(scn, cC2.sid).animRootSid === cP.sid,
    JSON.stringify(scn.surfaces.map((s) => [s.title, s.animRootSid])));
  kernel._wmAnims.get(cP.sid).t0 -= 100000;   // expire the restore fly
  scn = kernel.wmScene();
  check('linkage clears once the restore fly expires',
    sceneSid(scn, cC1.sid).animRootSid === 0 && sceneSid(scn, cC2.sid).animRootSid === 0,
    JSON.stringify(scn.surfaces.map((s) => [s.title, s.animRootSid])));
  shot = kernel.wmScreenshotScreen();
  check('restore shows the subtree again', String(px(shot, 212, 122)) === '0,255,0,255');

  // ---- thumbnail composites the anchored subtree (A10) ----
  const thumb = kernel.wmThumbnail(cP.sid, 512, 512);
  check('thumbnail shows child pixels at anchor position',
    thumb && String(px(thumb, 12, 22)) === '0,255,0,255' && String(px(thumb, 17, 27)) === '0,0,255,255' &&
    String(px(thumb, 5, 5)) === '255,0,0,255',
    thumb && [px(thumb, 12, 22), px(thumb, 17, 27), px(thumb, 5, 5)].join(' | '));

  // ---- A5: owner-initiated child resize + dst re-derivation ----
  drain(ringA);
  const rr = await rpc(a, K.OP.SURFACE_RESIZE, { sid: cC1.sid, w: 50, h: 20 });
  check('SURFACE_RESIZE on a child accepted (owner-side resize)', !rr.errno, JSON.stringify(rr));
  check('child got WINDOW_RESIZED', has(drain(ringA), K.WMEV.WINDOW_RESIZED, cC1.sid));
  const fbC1b = makeFb(50, 20);
  workers.get(a).msg({ type: 'wm-sabs', fb: fbC1b.sab, ring: null });
  const ack = await rpc(a, K.OP.SURFACE_CONFIGURE, { sid: cC1.sid, w: 50, h: 20 });
  check('configure ack accepted', !ack.errno && ack.w === 50, JSON.stringify(ack));
  check('resized child keeps anchor + inherited dst',
    byTitle('c1').w === 50 && byTitle('c1').dstW === 50 && byTitle('c1').x === 210 && byTitle('c1').y === 120,
    JSON.stringify(byTitle('c1')));
  kernel.wmSetDst(cP.sid, 200, 160);
  check('post-resize child still rides parent scale', byTitle('c1').dstW === 100 && byTitle('c1').dstH === 40,
    JSON.stringify(byTitle('c1')));
  kernel.wmSetDst(cP.sid, 100, 80);

  // ---- the grab (A2) ----
  const mkGrab = async () => {
    const fbG = makeFb(40, 30);
    workers.get(a).msg({ type: 'wm-sabs', fb: fbG.sab, ring: null });
    return rpc(a, K.OP.SURFACE_CREATE, { w: 40, h: 30, title: 'g', flags: 64 | 128, parentSid: cP.sid, dx: 0, dy: 30 });
  };
  let cG = await mkGrab();
  check('grab popup created', cG.sid > 0, JSON.stringify(cG));
  kernel.wmFocus(cP.sid);
  drain(ringA); drain(ringB);
  // press OUTSIDE the tree (Q's client) -> dismiss + consume, press AND release
  check('outside press is consumed', kernel.wmPointer('down', 460, 310, {}) === 'grab-dismiss');
  check('matching release is consumed too', kernel.wmPointer('up', 460, 310, {}) === 'grab-swallow');
  check('holder got the dismiss (QUIT)', has(drain(ringA), QUIT, cG.sid));
  check('the press never reached Q', !has(drain(ringB), BTN_DOWN), 'Q saw the consumed click');
  check('focus unchanged by the consumed click', byTitle('pa').focused === true);
  // the grab released at the dismissing press: the next click routes
  check('grab released: next click routes normally', kernel.wmPointer('down', 460, 310, {}) === 'client');
  kernel.wmPointer('up', 460, 310, {});
  check('...and reaches Q', has(drain(ringB), BTN_DOWN, cQ.sid));
  await rpc(a, K.OP.SURFACE_DESTROY, { sid: cG.sid });
  // presses INSIDE the tree route normally (the in-process engine's turf)
  cG = await mkGrab();
  kernel.wmFocus(cP.sid);
  drain(ringA);
  check('client press inside the tree routes with the grab up',
    kernel.wmPointer('down', 212, 122, {}) === 'client');
  kernel.wmPointer('up', 212, 122, {});
  check('...to the child surface', has(drain(ringA), BTN_DOWN, cC1.sid));
  // chrome is outside: a press on P's OWN title dismisses + consumes (Win95)
  check('own-title press dismisses + consumes', kernel.wmPointer('down', 250, 90, {}) === 'grab-dismiss');
  kernel.wmPointer('up', 250, 90, {});
  check('holder got that dismiss too', has(drain(ringA), QUIT, cG.sid));
  // desktop press dismisses too
  cG = await mkGrab();
  drain(ringA);
  check('desktop press dismisses + consumes', kernel.wmPointer('down', 600, 460, {}) === 'grab-dismiss');
  kernel.wmPointer('up', 600, 460, {});
  check('holder got the desktop dismiss', has(drain(ringA), QUIT, cG.sid));
  // destroy releases the grab
  cG = await mkGrab();
  await rpc(a, K.OP.SURFACE_DESTROY, { sid: cG.sid });
  check('destroying the holder releases the grab',
    kernel.wmPointer('down', 460, 310, {}) === 'client');
  kernel.wmPointer('up', 460, 310, {});
  drain(ringA); drain(ringB);

  // ---- grab vs pointer lock: the lock branch outranks (documented) ----
  await rpc(b, K.OP.SURFACE_SET_FLAGS, { sid: cQ.sid, flags: 2 });   // relative mouse
  kernel.wmFocus(cQ.sid);
  kernel.wmPointerLockChanged(true);
  cG = await mkGrab();
  drain(ringB);
  check('pointer lock outranks the grab (locked routing, no dismissal)',
    kernel.wmPointer('down', 10, 10, {}) === 'locked');
  kernel.wmPointer('up', 10, 10, {});
  check('...locked events reach the locked surface', has(drain(ringB), BTN_DOWN, cQ.sid));
  kernel.wmPointerLockChanged(false);
  await rpc(b, K.OP.SURFACE_SET_FLAGS, { sid: cQ.sid, flags: 0 });
  // per-window injection is post-hit-test by design: the grab never sees it
  drain(ringB);
  check('wmInjectPointer bypasses the grab', kernel.wmInjectPointer(cQ.sid, 'down', 5, 5) === 0 &&
    has(drain(ringB), BTN_DOWN, cQ.sid));
  await rpc(a, K.OP.SURFACE_DESTROY, { sid: cG.sid });

  // ---- the focus funnel (A9): all three transitions emit the owner pair ----
  kernel.wmFocus(cP.sid);
  drain(ringA); drain(ringB);
  // 1. wmFocus
  kernel.wmFocus(cQ.sid);
  check('wmFocus: LOST to the old owner', has(drain(ringA), FOCUS_LOST, cP.sid));
  check('wmFocus: GAINED to the new owner', has(drain(ringB), FOCUS_GAINED, cQ.sid));
  // 2. create-steal by another process's window
  const fbR = makeFb(60, 40);
  workers.get(a).msg({ type: 'wm-sabs', fb: fbR.sab, ring: null });
  const cR = await rpc(a, K.OP.SURFACE_CREATE, { w: 60, h: 40, title: 'ra', flags: 0 });
  check('create-steal: LOST to the prior focus owner', has(drain(ringB), FOCUS_LOST, cQ.sid));
  check('create-steal: GAINED to the new window', has(drain(ringA), FOCUS_GAINED, cR.sid));
  // 3. the focus fall (minimize)
  kernel.wmMinimize(cR.sid);
  check('focus fall: LOST to the minimized window', has(drain(ringA), FOCUS_LOST, cR.sid));
  check('focus fall: GAINED to the fall target', has(drain(ringB), FOCUS_GAINED, cQ.sid));
  await rpc(a, K.OP.SURFACE_DESTROY, { sid: cR.sid });

  // ---- destroy cascade: mid-tree, then the whole tree ----
  check('pre-cascade: c1 subtree live', !!byTitle('c1') && !!byTitle('c2'));
  await rpc(a, K.OP.SURFACE_DESTROY, { sid: cC1.sid });
  check('destroying a mid-tree child cascades its own subtree only',
    !byTitle('c1') && !byTitle('c2') && !!byTitle('pa'), zOrder());
  const fbC3 = makeFb(20, 20);
  workers.get(a).msg({ type: 'wm-sabs', fb: fbC3.sab, ring: null });
  const cC3 = await rpc(a, K.OP.SURFACE_CREATE, { w: 20, h: 20, title: 'c3', flags: 64, parentSid: cP.sid, dx: 0, dy: 0 });
  await rpc(a, K.OP.SURFACE_DESTROY, { sid: cP.sid });
  check('destroying the parent cascades every child', !byTitle('pa') && !byTitle('c3') && cC3.sid > 0, zOrder());
  check('nothing orphaned in the z-order',
    kernel.wmList().every((w) => w.title === 'qb'), zOrder());

  console.log(failures === 0 ? '\nwm anchored: PASS' : `\nwm anchored: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
