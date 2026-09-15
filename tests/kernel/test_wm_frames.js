#!/usr/bin/env node
// #790 configure serials, buffer generations and frame identities:
// deterministic kernel RPC tests over fake workers (the test_wm.js shape).
// No boot, no browser, no manual evidence. What is pinned here:
//   - CREATE stamps generation 1 (an allocator leaving SH_GEN 0), refuses any
//     other claimed generation;
//   - every issued configure carries a fresh monotonic serial in the
//     WINDOW_RESIZED record (word [4]); SURFACE_RESIZE replies with it;
//   - the ack must NAME the serial and the buffer's SH_GEN must equal it;
//     a still-valid issued serial newer than the committed one is accepted
//     (a superseded one re-issues the pending target under ITS serial);
//     unknown / retired / backward serials are ESTALE and move nothing;
//   - at most WM_CFG_OUTSTANDING issued configures stay valid (oldest retire);
//   - an equal-size reconfigure is a NEW generation: pixels come from the new
//     buffer, the old SAB's flips are ignored;
//   - DECLINE (no SAB) retires the serial and everything older, clears the
//     pending target and emits EV_CONFIGURE_DECLINED — no pending state leaks;
//   - destroy with a configure in flight: the late ack is EINVAL, a late gpu
//     frame is closed;
//   - gpu frames of a retired serial or a non-committed size are rejected
//     (closed, counted); the committed serial (or a legacy 0) is accepted;
//   - pointer records carry the committed serial as their geometry epoch;
//   - GET_STATE / wmList expose buffer/dst/serial identities;
//   - a seeded storm keeps SAB W/H/GEN == surface w/h/committedSerial after
//     EVERY op (the "atomic from the compositor's view" invariant);
//   - the kernel-side front-buffer read (wmScreenshot) takes SH_LOCK, never
//     waits past its bound, and counts a miss when a producer wedges it.
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

// ---- fake worker plumbing ----
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
  ['/bin/other', new Uint8Array([3])],
]);
const store = new BLOCK_FS.MemoryByteStore(1 << 20);
const kfs = BLOCK_FS.createV4(store);
const logLines = [];
const kernel = new K.Kernel({
  fs: kfs, createWorker,
  loadImage: (p) => images.get(p) || null,
  onHalt: () => {}, onPointerLock: () => {},
  log: (m) => logLines.push(m),
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
function makeFb(w, h, gen) {
  const sab = new SharedArrayBuffer(K.SH_HDR_BYTES + 2 * w * h * 4);
  const i32 = new Int32Array(sab);
  i32[K.SH_MAGIC] = K.SH_MAGIC_VALUE;
  i32[K.SH_W] = w; i32[K.SH_H] = h; i32[K.SH_FORMAT] = 0;
  i32[K.SH_GEN] = gen | 0;
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
    const rec = { type: ring.i32[base], win: ring.i32[base + 1], w: [] };
    for (let k = 0; k < 8; k++) rec.w.push(ring.i32[base + k]);
    out.push(rec);
    rpos = (rpos + 1) % cap2;
    Atomics.store(ring.i32, K.IR_RPOS, rpos);
  }
  return out;
}
const resized = (evs) => evs.filter((e) => e.type === K.WMEV.WINDOW_RESIZED);
const px = (shot, x, y) => Array.from(shot.rgba.subarray((y * shot.w + x) * 4, (y * shot.w + x) * 4 + 4));
const row = (sid) => kernel.wmList().find((s) => s.sid === sid);
// A spy on the WM emit funnel: records every emitted event even with no
// subscriber (the policy test owns the wire shape; this pins the emission).
const emitted = [];
const origEmit = kernel._wmEmit.bind(kernel);
kernel._wmEmit = function (type, payload, title) {
  emitted.push({ type, payload: payload instanceof Uint8Array ? null : payload.slice() });
  return origEmit(type, payload, title);
};
const lastEmit = (type) => { for (let i = emitted.length - 1; i >= 0; i--) if (emitted[i].type === type) return emitted[i]; return null; };

async function create(pid, w, h, ring, gen, flags) {
  const fb = makeFb(w, h, gen);
  workers.get(pid).msg({ type: 'wm-sabs', fb: fb.sab, ring: ring ? ring.sab : null });
  const r = await rpc(pid, K.OP.SURFACE_CREATE, { w, h, title: 't' + w + 'x' + h, flags: flags | 0 });
  return { r, fb };
}
async function ack(pid, sid, w, h, serial, opts) {
  const o = opts || {};
  const fb = makeFb(w, h, o.gen === undefined ? serial : o.gen);
  if (o.rgba) present(fb, o.rgba);
  workers.get(pid).msg({ type: 'wm-sabs', fb: fb.sab, ring: null });
  const r = await rpc(pid, K.OP.SURFACE_CONFIGURE, { sid, w, h, serial });
  return { r, fb };
}

(async () => {
  const initPid = await kernel.boot({ path: '/bin/init' });
  check('boots', initPid === 1);
  const r1 = await rpc(1, K.OP.SPAWN, { path: '/bin/app', argv: ['app'], envp: [], actions: [], flags: 0 });
  const app = r1.pid;
  const r2 = await rpc(1, K.OP.SPAWN, { path: '/bin/other', argv: ['other'], envp: [], actions: [], flags: 0 });
  const other = r2.pid;
  check('spawned app + other', app > 1 && other > app);
  const ring = makeRing(256);

  // ---- A. create identity ----
  const bad = await create(app, 80, 48, ring, 5);
  check('CREATE with a claimed generation != 1 -> EINVAL', bad.r.errno === 'EINVAL', JSON.stringify(bad.r));
  const c1 = await create(app, 80, 48, ring, 0, 4 /* resizable */);
  const sid = c1.r.sid;
  check('CREATE ok, resizable', !c1.r.errno && sid > 0, JSON.stringify(c1.r));
  check('CREATE stamps generation 1 into an unstamped header', Atomics.load(c1.fb.i32, K.SH_GEN) === 1);
  let s = row(sid);
  check('wmList: committedSerial 1, pendingSerial 0, gen 1',
    s.committedSerial === 1 && s.pendingSerial === 0 && s.gen === 1 && s.configurePending === false, JSON.stringify(s));
  let st = await rpc(app, K.OP.SURFACE_GET_STATE, { sid });
  check('GET_STATE exposes buffer/dst/configure identities',
    st.buffer && st.buffer.w === 80 && st.buffer.h === 48 && st.buffer.gen === 1 && st.buffer.frameSeq === 0 &&
    st.dst && st.dst.w === 80 && st.dst.h === 48 &&
    st.configure && st.configure.committed === 1 && st.configure.pending === 0 && st.configure.outstanding === 0,
    JSON.stringify(st));
  kernel.wmMove(sid, 100, 100);
  drain(ring);

  // ---- B. issue + ack identity ----
  check('wmResize asks', kernel.wmResize(sid, 100, 80) === 0);
  let evs = resized(drain(ring));
  const s2 = evs[0].w[4];
  check('WINDOW_RESIZED carries serial 2 (word [4])', evs.length === 1 && s2 === 2 && evs[0].w[2] === 100 && evs[0].w[3] === 80, JSON.stringify(evs));
  s = row(sid);
  check('wmList: pendingSerial 2 while pending', s.pendingSerial === 2 && s.configurePending === true && s.committedSerial === 1, JSON.stringify(s));
  st = await rpc(app, K.OP.SURFACE_GET_STATE, { sid });
  check('GET_STATE: configure.pending 2 with its dims, outstanding 1',
    st.configure.pending === 2 && st.configure.pendingW === 100 && st.configure.pendingH === 80 && st.configure.outstanding === 1,
    JSON.stringify(st.configure));
  let a = await ack(app, sid, 100, 80, 2, { gen: 1 });
  check('ack whose SH_GEN != serial -> EINVAL', a.r.errno === 'EINVAL', JSON.stringify(a.r));
  check('...geometry untouched', row(sid).w === 80 && row(sid).committedSerial === 1);
  const stale0 = kernel.configureStaleCount();
  a = await ack(app, sid, 100, 80, 99);
  check('ack naming an unknown serial -> ESTALE', a.r.errno === 'ESTALE', JSON.stringify(a.r));
  check('...counted, geometry untouched', kernel.configureStaleCount() === stale0 + 1 && row(sid).w === 80 && row(sid).pendingSerial === 2);
  a = await ack(app, sid, 100, 80, 2, { rgba: [1, 2, 3, 255] });
  check('ack naming serial 2 with SH_GEN 2 -> accepted, reply carries serial + gen',
    !a.r.errno && a.r.w === 100 && a.r.serial === 2 && a.r.gen === 2, JSON.stringify(a.r));
  s = row(sid);
  check('committed 2, nothing pending, gen 2', s.committedSerial === 2 && s.pendingSerial === 0 && s.gen === 2 && s.w === 100 && s.h === 80, JSON.stringify(s));
  const ev = lastEmit(K.WMP.EV_CONFIGURED);
  check('EV_CONFIGURED { sid, w, h, serial }', ev && ev.payload[0] === sid && ev.payload[1] === 100 && ev.payload[2] === 80 && ev.payload[3] === 2, JSON.stringify(ev));
  {
    const st0 = kernel.configureStaleCount();
    a = await ack(app, sid, 100, 80, 2);
    check('a second ack with nothing pending -> ESTALE (one identity shape), counted',
      a.r.errno === 'ESTALE' && kernel.configureStaleCount() === st0 + 1, JSON.stringify(a.r));
  }

  // ---- C. superseded / backward ----
  kernel.wmResize(sid, 110, 81); kernel.wmResize(sid, 120, 82); kernel.wmResize(sid, 130, 83);
  evs = resized(drain(ring));
  const [s3, s4, s5] = evs.map((e) => e.w[4]);
  check('three issues -> serials 3,4,5', s3 === 3 && s4 === 4 && s5 === 5, JSON.stringify([s3, s4, s5]));
  a = await ack(app, sid, 120, 82, 4, { rgba: [4, 4, 4, 255] });
  check('acking a superseded-but-valid serial (4) is accepted', !a.r.errno && a.r.serial === 4, JSON.stringify(a.r));
  evs = resized(drain(ring));
  check('...and the pending target (5) is re-issued under ITS serial', evs.length === 1 && evs[0].w[4] === 5 && evs[0].w[2] === 130, JSON.stringify(evs));
  a = await ack(app, sid, 110, 81, 3);
  check('acking serial 3 after committing 4 -> ESTALE (never backward)', a.r.errno === 'ESTALE', JSON.stringify(a.r));
  check('...committed geometry stays 120x82 @4', row(sid).w === 120 && row(sid).committedSerial === 4 && row(sid).pendingSerial === 5);
  a = await ack(app, sid, 130, 83, 5, { rgba: [5, 5, 5, 255] });
  check('acking the pending target settles', !a.r.errno && row(sid).pendingSerial === 0 && row(sid).committedSerial === 5);
  a = await ack(app, sid, 130, 83, 5);
  check('re-acking the committed serial -> ESTALE (never backward, even with nothing pending)', a.r.errno === 'ESTALE');
  {
    // an ack whose dims contradict the issued serial's dims: ESTALE (identity
    // is serial + dims; the SAB header matched its own claim so it is not EINVAL)
    kernel.wmResize(sid, 140, 84);
    const e6 = resized(drain(ring))[0].w[4];
    a = await ack(app, sid, 141, 84, e6);
    check('ack with dims that are not the serial\'s -> ESTALE', a.r.errno === 'ESTALE' && row(sid).w === 130, JSON.stringify(a.r));
    a = await ack(app, sid, 140, 84, e6);
    check('the right dims settle it', !a.r.errno && row(sid).w === 140 && row(sid).committedSerial === e6);
  }

  // ---- D. the outstanding bound ----
  const first = row(sid).committedSerial + 1;
  for (let i = 0; i < K.WM_CFG_OUTSTANDING + 1; i++) kernel.wmResize(sid, 150 + i, 90);
  evs = resized(drain(ring));
  check('WM_CFG_OUTSTANDING+1 issues delivered', evs.length === K.WM_CFG_OUTSTANDING + 1 && evs[0].w[4] === first, JSON.stringify(evs.map((e) => e.w[4])));
  st = await rpc(app, K.OP.SURFACE_GET_STATE, { sid });
  check('only WM_CFG_OUTSTANDING stay valid', st.configure.outstanding === K.WM_CFG_OUTSTANDING, JSON.stringify(st.configure));
  a = await ack(app, sid, 150, 90, first);
  check('the retired oldest serial -> ESTALE', a.r.errno === 'ESTALE', JSON.stringify(a.r));
  const newest = evs[evs.length - 1].w[4];
  a = await ack(app, sid, 150 + K.WM_CFG_OUTSTANDING, 90, newest, { rgba: [9, 9, 9, 255] });
  check('the newest settles, outstanding 0', !a.r.errno && (await rpc(app, K.OP.SURFACE_GET_STATE, { sid })).configure.outstanding === 0);

  // ---- E. equal-size regeneration ----
  {
    const cur = row(sid);
    present(a.fb, [10, 20, 30, 255]);
    check('current pixels from the current buffer', String(px(kernel.wmScreenshot(sid), 1, 1)) === '10,20,30,255');
    kernel.wmResize(sid, cur.w + 10, cur.h);            // pending: bigger
    kernel.wmResize(sid, cur.w, cur.h);                 // pending: back to the SAME size
    evs = resized(drain(ring));
    const same = evs[1].w[4];
    check('an equal-size request while pending is a real configure', evs.length === 2 && evs[1].w[2] === cur.w && evs[1].w[3] === cur.h);
    const regen = await ack(app, sid, cur.w, cur.h, same, { rgba: [200, 100, 50, 255] });
    check('equal-size ack accepted as a NEW generation', !regen.r.errno && row(sid).gen === same && row(sid).w === cur.w, JSON.stringify(regen.r));
    check('pixels come from the new buffer', String(px(kernel.wmScreenshot(sid), 1, 1)) === '200,100,50,255');
    present(a.fb, [7, 7, 7, 255]);                       // the abandoned old SAB
    check('old-generation flips are ignored', String(px(kernel.wmScreenshot(sid), 1, 1)) === '200,100,50,255');
    a = regen;
  }

  // ---- F. decline ----
  {
    const before = row(sid);
    kernel.wmResize(sid, 300, 200);
    const sd = resized(drain(ring))[0].w[4];
    const stD = kernel.configureStaleCount();
    let d = await rpc(app, K.OP.SURFACE_CONFIGURE, { sid, w: 300, h: 200, serial: 77, decline: true });
    check('declining an unknown serial -> ESTALE, counted', d.errno === 'ESTALE' && kernel.configureStaleCount() === stD + 1);
    d = await rpc(app, K.OP.SURFACE_CONFIGURE, { sid, w: 300, h: 200, serial: sd, decline: true });
    check('declining the pending serial -> ok', !d.errno, JSON.stringify(d));
    s = row(sid);
    check('...nothing pending, geometry unchanged', s.pendingSerial === 0 && s.configurePending === false && s.w === before.w && s.committedSerial === before.committedSerial, JSON.stringify(s));
    const de = lastEmit(K.WMP.EV_CONFIGURE_DECLINED);
    check('EV_CONFIGURE_DECLINED { sid, serial, w, h }', de && de.payload[0] === sid && de.payload[1] === sd && de.payload[2] === 300 && de.payload[3] === 200, JSON.stringify(de));
    check('GET_STATE outstanding 0 after the decline', (await rpc(app, K.OP.SURFACE_GET_STATE, { sid })).configure.outstanding === 0);
    // declining an OLDER still-issued serial keeps a newer pending target
    kernel.wmResize(sid, 310, 210); kernel.wmResize(sid, 320, 220);
    evs = resized(drain(ring));
    const [oa, ob] = evs.map((e) => e.w[4]);
    d = await rpc(app, K.OP.SURFACE_CONFIGURE, { sid, w: 310, h: 210, serial: oa, decline: true });
    check('declining the older serial keeps the newer target pending', !d.errno && row(sid).pendingSerial === ob, JSON.stringify(row(sid)));
    a = await ack(app, sid, 320, 220, ob, { rgba: [1, 1, 1, 255] });
    check('...which then settles', !a.r.errno && row(sid).committedSerial === ob && row(sid).pendingSerial === 0);
    d = await rpc(app, K.OP.SURFACE_CONFIGURE, { sid, w: 320, h: 220, serial: ob, decline: true });
    check('declining with nothing pending -> ESTALE (the committed serial is not issued)', d.errno === 'ESTALE');
    // ---- the re-issue that cannot be delivered (full ring) retires the
    // outstanding set and tells policy (EV_CONFIGURE_DECLINED) — no leak ----
    kernel.wmResize(sid, 330, 230); kernel.wmResize(sid, 340, 240);
    const [ra, rb] = resized(drain(ring)).map((e) => e.w[4]);
    for (let i = 0; i < ring.cap + 4; i++) kernel.wmInjectKey(sid, true, 4, 97, 0);   // fill the ring
    const emitN = emitted.length;
    a = await ack(app, sid, 330, 230, ra, { rgba: [3, 3, 3, 255] });
    check('superseded ack accepted while the ring is full', !a.r.errno && row(sid).committedSerial === ra, JSON.stringify(a.r));
    const lost = emitted.slice(emitN).find((e) => e.type === K.WMP.EV_CONFIGURE_DECLINED);
    check('undeliverable re-issue: pending cleared, outstanding 0, EV_CONFIGURE_DECLINED names the lost target',
      row(sid).pendingSerial === 0 && (await rpc(app, K.OP.SURFACE_GET_STATE, { sid })).configure.outstanding === 0 &&
      lost && lost.payload[1] === rb && lost.payload[2] === 340 && lost.payload[3] === 240, JSON.stringify([row(sid).pendingSerial, lost]));
    drain(ring);
    a = await ack(app, sid, 340, 240, rb);
    check('...and the lost serial is ESTALE afterwards', a.r.errno === 'ESTALE');
  }

  // ---- G. destroy with a configure in flight ----
  {
    const c2 = await create(app, 40, 30, null, 0, 4);
    const sid2 = c2.r.sid;
    kernel.wmResize(sid2, 60, 40);
    const sx = resized(drain(ring))[0].w[4];
    const dr = await rpc(app, K.OP.SURFACE_DESTROY, { sid: sid2 });
    check('destroy while a configure is pending -> ok', !dr.errno);
    a = await ack(app, sid2, 60, 40, sx);
    check('the late ack -> EINVAL (surface gone)', a.r.errno === 'EINVAL', JSON.stringify(a.r));
    let closed = 0;
    workers.get(app).msg({ type: 'wm-frame', sid: sid2, bmp: { width: 60, height: 40, close() { closed++; } }, serial: sx });
    check('a late gpu frame for the dead sid is closed', closed === 1);
    check('no pending SAB left on the pcb', kernel.process(app)._wmPendingFb === null);
  }

  // ---- H. gpu frame identity ----
  {
    const c3 = await create(app, 50, 40, null, 0, 4);
    const sid3 = c3.r.sid;
    const rej0 = kernel.wmFrameRejectedCount();
    let closedA = 0;
    const bmpA = { width: 50, height: 40, close() { closedA++; } };
    workers.get(app).msg({ type: 'wm-frame', sid: sid3, bmp: bmpA, serial: 1 });
    check('a frame for the committed serial (1) is accepted', row(sid3).frameSeq === 1 && closedA === 0 && kernel.wmFrameRejectedCount() === rej0);
    let closedB = 0;
    workers.get(app).msg({ type: 'wm-frame', sid: sid3, bmp: { width: 51, height: 40, close() { closedB++; } }, serial: 1 });
    check('a frame of another SIZE for the committed serial is accepted (scaled presentation, as before #790)',
      closedB === 0 && closedA === 1 && kernel.wmFrameRejectedCount() === rej0 && row(sid3).frameSeq === 2);
    kernel.wmResize(sid3, 70, 50);
    const sg = resized(drain(ring))[0].w[4];
    // pre-ack: a frame at the OLD size for the OLD serial is still current
    let closedC = 0;
    workers.get(app).msg({ type: 'wm-frame', sid: sid3, bmp: { width: 50, height: 40, close() { closedC++; } }, serial: 1 });
    check('pre-ack old-size frame for the committed serial still accepted', closedC === 0 && closedB === 1 && row(sid3).frameSeq === 3);
    a = await ack(app, sid3, 70, 50, sg, { rgba: [3, 3, 3, 255] });
    check('gpu-style ack accepted', !a.r.errno);
    let closedD = 0;
    workers.get(app).msg({ type: 'wm-frame', sid: sid3, bmp: { width: 50, height: 40, close() { closedD++; } }, serial: 1 });
    check('post-ack frame of the RETIRED serial is rejected', closedD === 1 && kernel.wmFrameRejectedCount() === rej0 + 1);
    let closedE = 0;
    workers.get(app).msg({ type: 'wm-frame', sid: sid3, bmp: { width: 70, height: 50, close() { closedE++; } }, serial: sg });
    check('post-ack frame of the committed serial + size is accepted', closedE === 0);
    let closedF = 0;
    workers.get(app).msg({ type: 'wm-frame', sid: sid3, bmp: { width: 70, height: 50, close() { closedF++; } } });
    check('a legacy frame without a serial keeps the size check only', closedF === 0 && closedE === 1);
    const cross = await create(other, 70, 50, null, 0, 0);
    let closedG = 0;
    workers.get(other).msg({ type: 'wm-frame', sid: sid3, bmp: { width: 70, height: 50, close() { closedG++; } }, serial: sg });
    check('a frame from a foreign process is closed', closedG === 1 && !cross.r.errno);
    // a gpu surface cannot be read by the headless composite (by design) —
    // retire it before the composite legs below
    await rpc(app, K.OP.SURFACE_DESTROY, { sid: sid3 });
  }

  // ---- I. pointer records carry the geometry epoch ----
  {
    const cur = row(sid);
    kernel.wmFocus(sid);
    drain(ring);
    kernel.wmPointer('move', cur.x + 5, cur.y + 5, {});
    kernel.wmPointer('down', cur.x + 5, cur.y + 5, { button: 1 });
    kernel.wmPointer('up', cur.x + 5, cur.y + 5, { button: 1 });
    kernel.wmPointer('wheel', cur.x + 5, cur.y + 5, { wheelY: 1 });
    kernel.wmInjectKey(sid, true, 4, 97, 0);
    evs = drain(ring);
    const ptr = evs.filter((e) => e.type === K.WMEV.MOUSEMOTION || e.type === K.WMEV.MOUSEBUTTONDOWN ||
                                  e.type === K.WMEV.MOUSEBUTTONUP || e.type === K.WMEV.MOUSEWHEEL);
    const key = evs.filter((e) => e.type === K.WMEV.KEYDOWN);
    check('four pointer records, each stamped with the committed serial (word [6])',
      ptr.length === 4 && ptr.every((e) => e.w[6] === cur.committedSerial), JSON.stringify(ptr.map((e) => [e.type, e.w[6]])));
    check('key records are not stamped', key.length === 1 && key[0].w[6] === 0);
    kernel.wmResize(sid, cur.w + 2, cur.h);
    const sn = resized(drain(ring))[0].w[4];
    kernel.wmPointer('move', cur.x + 6, cur.y + 6, {});
    let mid = drain(ring).filter((e) => e.type === K.WMEV.MOUSEMOTION);
    check('while pending, records still carry the OLD committed serial', mid.length === 1 && mid[0].w[6] === cur.committedSerial);
    a = await ack(app, sid, cur.w + 2, cur.h, sn, { rgba: [2, 2, 2, 255] });
    drain(ring);
    kernel.wmPointer('move', cur.x + 7, cur.y + 7, {});
    mid = drain(ring).filter((e) => e.type === K.WMEV.MOUSEMOTION);
    check('after the ack, records carry the NEW committed serial', mid.length === 1 && mid[0].w[6] === sn, JSON.stringify(mid));
    const inj = kernel.wmInjectPointer(sid, 'move', 1, 1, {});
    mid = drain(ring).filter((e) => e.type === K.WMEV.MOUSEMOTION);
    check('injected pointer records are stamped too', inj === 0 && mid.length === 1 && mid[0].w[6] === sn);
  }

  // ---- J. seeded storm: geometry + buffer identity after EVERY op ----
  {
    let seed = 0x790;
    const rnd = (n) => { seed = (seed * 1103515245 + 12345) >>> 0; return seed % n; };
    const cs = await create(app, 64, 64, null, 0, 4);
    const ssid = cs.r.sid;
    let fbs = new Map([[1, cs.fb]]);   // serial -> SAB we allocated for it
    let issued = [];
    const everIssued = [];   // every serial ever issued — retired ones are stale picks
    let bad = 0, acks = 0, stales = 0, declines = 0;
    const invariant = () => {
      const r = row(ssid);
      const st2 = kernel._surfaces.get(ssid);
      const i32 = st2.i32;
      if (Atomics.load(i32, K.SH_W) !== r.w || Atomics.load(i32, K.SH_H) !== r.h) return 'SAB dims != surface dims';
      if (Atomics.load(i32, K.SH_GEN) !== r.committedSerial || r.gen !== r.committedSerial) return 'SAB gen != committed serial';
      if (r.pendingSerial && r.pendingSerial <= r.committedSerial) return 'pending not newer than committed';
      if (st2.issued.length > K.WM_CFG_OUTSTANDING) return 'issued over the bound';
      if (st2.pendingConfigure && st2.issued[st2.issued.length - 1] !== st2.pendingConfigure) return 'pending is not the newest issued';
      if (!st2.pendingConfigure && st2.issued.length) return 'issued left without a pending target';
      return null;
    };
    for (let i = 0; i < 300 && !bad; i++) {
      const op = rnd(10);
      if (op < 4) {
        kernel.wmResize(ssid, 32 + rnd(200), 32 + rnd(200));
        for (const e of resized(drain(ring))) { const c = { serial: e.w[4], w: e.w[2], h: e.w[3] }; issued.push(c); everIssued.push(c); }
        while (issued.length > K.WM_CFG_OUTSTANDING) issued.shift();   // mirror the kernel's retirement
      } else if (op < 8 && issued.length) {
        // mostly a still-valid serial; sometimes ANY serial ever issued (a
        // retired/committed one is the stale case)
        const pick = rnd(6) === 0 ? everIssued[rnd(everIssued.length)] : issued[rnd(issued.length)];
        const r0 = row(ssid);
        const res = await ack(app, ssid, pick.w, pick.h, pick.serial, { rgba: [pick.serial & 255, 1, 2, 255] });
        for (const e of resized(drain(ring))) { /* re-issued target: already known */ }
        if (!res.r.errno) { acks++; fbs.set(pick.serial, res.fb); issued = issued.filter((c) => c.serial > pick.serial); }
        else if (res.r.errno === 'ESTALE') { stales++; issued = issued.filter((c) => c.serial !== pick.serial); if (row(ssid).w !== r0.w || row(ssid).committedSerial !== r0.committedSerial) bad = 'ESTALE moved geometry'; }
        else bad = 'unexpected ack errno ' + res.r.errno;
      } else if (op < 9 && issued.length) {
        const pick = issued[rnd(issued.length)];
        const d = await rpc(app, K.OP.SURFACE_CONFIGURE, { sid: ssid, w: pick.w, h: pick.h, serial: pick.serial, decline: true });
        if (!d.errno) { declines++; issued = issued.filter((c) => c.serial > pick.serial); }
        else if (d.errno !== 'ESTALE') bad = 'unexpected decline errno ' + d.errno;
        else issued = issued.filter((c) => c.serial !== pick.serial);
      } else {
        const cur = fbs.get(row(ssid).committedSerial);
        if (cur) { present(cur, [rnd(255), rnd(255), rnd(255), 255]); if (px(kernel.wmScreenshot(ssid), 0, 0)[3] !== 255) bad = 'screenshot did not read the committed buffer'; }
      }
      const v = invariant();
      if (v) bad = v + ' at op ' + i;
    }
    check('storm: ' + acks + ' acks / ' + stales + ' stale / ' + declines + ' declines kept every identity invariant', !bad, bad);
    check('storm exercised every path', acks > 20 && stales > 5 && declines > 3, JSON.stringify([acks, stales, declines]));
  }

  // ---- K. the kernel-side read takes SH_LOCK, bounded ----
  {
    const surf = kernel._surfaces.get(sid);
    const miss0 = kernel.shmLockMisses();
    kernel.wmScreenshot(sid);
    check('a normal screenshot leaves SH_LOCK free and misses nothing', Atomics.load(surf.i32, K.SH_LOCK) === 0 && kernel.shmLockMisses() === miss0);
    Atomics.store(surf.i32, K.SH_LOCK, 1);          // a wedged producer
    const t0 = Date.now();
    const shot = kernel.wmScreenshot(sid);
    check('a wedged lock never blocks the kernel read past its bound', !!shot && Date.now() - t0 < 5000 && kernel.shmLockMisses() === miss0 + 1);
    // the producer's own miss counter rides the header (SH_PMISS) and is
    // visible through wmList / GET_STATE / the summed probe
    Atomics.add(surf.i32, K.SH_PMISS, 2);
    check('producer flip misses (SH_PMISS) surface in wmList, GET_STATE and shmFlipMisses()',
      row(sid).flipMisses === 2 && (await rpc(app, K.OP.SURFACE_GET_STATE, { sid })).buffer.flipMisses === 2 && kernel.shmFlipMisses() >= 2);
    Atomics.store(surf.i32, K.SH_PMISS, 0);
    check('...and the read did not steal the lock', Atomics.load(surf.i32, K.SH_LOCK) === 1);
    Atomics.store(surf.i32, K.SH_LOCK, 0);
    kernel.wmScreenshotScreen();
    check('the headless composite reads under the lock and releases it', Atomics.load(surf.i32, K.SH_LOCK) === 0 && kernel.shmLockMisses() === miss0 + 1);
  }

  // ---- L. wm-sabs handshake hygiene: an unused pending SAB never leaks into a later ack ----
  {
    const cur = row(sid);
    kernel.wmResize(sid, cur.w + 1, cur.h);
    const sl = resized(drain(ring))[0].w[4];
    workers.get(app).msg({ type: 'wm-sabs', fb: makeFb(cur.w + 1, cur.h, sl).sab, ring: null });
    const d = await rpc(app, K.OP.SURFACE_CONFIGURE, { sid, w: cur.w + 1, h: cur.h, serial: sl, decline: true });
    check('a decline consumes (drops) the handshake SAB', !d.errno && kernel.process(app)._wmPendingFb === null);
  }

  console.log(failures ? `\ntest_wm_frames: ${failures} FAILED` : '\ntest_wm_frames: all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
