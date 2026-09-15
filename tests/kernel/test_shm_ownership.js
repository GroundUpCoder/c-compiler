#!/usr/bin/env node
// #790 REAL frame ownership on the shm transport, with real threads.
//
// The pre-#790 mailbox was a two-buffer flip with NO ownership word: the
// compositor read SH_FLIP and copied the front buffer while the producer's
// NEXT present wrote that same buffer (it had just become the back). This
// file proves the fix with a genuine race, not a narrative:
//
//   producer  = a worker_threads Worker hammering presents into the surface
//               SAB through host.js's wmShmFlip (fill the back buffer with
//               one byte value per frame, then flip UNDER SH_LOCK);
//   consumer  = the real kernel's wmScreenshot (the ONE kernel-side front-
//               buffer read; the headless composite and thumbnails funnel
//               through it), which holds SH_LOCK across its copy.
//
// A torn frame = a screenshot whose bytes are not all one value. GREEN: zero
// torn frames across the run, with the producer proven concurrent (hundreds
// of frames) and zero lock misses on either side. RED CONTROL: the SAME
// producer flipping WITHOUT the lock (plain store + add, the pre-#790
// mechanism) must produce torn screenshots — that is what proves this
// instrument can see tearing at all; a control that cannot tear is a FAIL.
'use strict';
const path = require('path');
const { Worker, isMainThread, workerData, parentPort } = require('worker_threads');
const K = require(path.resolve(__dirname, '../../kernel.js'));
const host = require(path.resolve(__dirname, '../../host.js'));

const W = 1024, H = 1024;                       // 4 MB per buffer: copies take
                                                // long enough to overlap presents
if (!isMainThread) {
  // ---- producer ----
  const { sab, control, locked } = workerData;
  const i32 = new Int32Array(sab);
  const u8 = new Uint8Array(sab);
  const ctl = new Int32Array(control);
  const bytes = W * H * 4;
  const fb = { i32 };
  let frames = 0;
  while (Atomics.load(ctl, 0) === 0) {
    const back = 1 - (Atomics.load(i32, K.SH_FLIP) & 1);
    const v = 1 + (frames % 250);
    u8.fill(v, K.SH_HDR_BYTES + back * bytes, K.SH_HDR_BYTES + (back + 1) * bytes);
    if (locked) host.wmShmFlip(fb, back);
    else { Atomics.store(i32, K.SH_FLIP, back); Atomics.add(i32, K.SH_SEQ, 1); }   // the pre-#790 flip
    frames++;
  }
  parentPort.postMessage({ frames, misses: host.wmShmFlipMisses() });
  return;
}

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}
const tick = () => new Promise((r) => setImmediate(r));
const { BLOCK_FS } = host;

// ---- fake worker plumbing (test_wm.js shape) ----
const workers = new Map();
function createWorker(procSpec) {
  const h = { procSpec, msg: null, postMessage() {}, onMessage(fn) { h.msg = fn; }, onExit(fn) { h.exitCb = fn; }, terminate() {} };
  workers.set(procSpec.pid, h);
  return h;
}
const images = new Map([['/bin/init', new Uint8Array([1])], ['/bin/app', new Uint8Array([2])]]);
const kfs = BLOCK_FS.createV4(new BLOCK_FS.MemoryByteStore(1 << 20));
const kernel = new K.Kernel({
  fs: kfs, createWorker, loadImage: (p) => images.get(p) || null,
  onHalt: () => {}, onPointerLock: () => {}, log: () => {}, screen: { w: 1280, h: 1100 },
});
function rpc(pid, op, req) {
  const h = workers.get(pid);
  const pcb = kernel.process(pid);
  const i32 = new Int32Array(pcb.page), u8 = new Uint8Array(pcb.page);
  K.writePayload(i32, u8, req);
  Atomics.store(i32, K.KP_RPC_OP, op);
  Atomics.store(i32, K.KP_RPC_STATE, K.RPC_REQUEST);
  h.msg({ type: 'krpc' });
  return (async () => {
    while (Atomics.load(i32, K.KP_RPC_STATE) !== K.RPC_DONE) await tick();
    const resp = K.readPayload(i32, u8);
    Atomics.store(i32, K.KP_RPC_STATE, K.RPC_IDLE);
    return resp;
  })();
}
function makeFb(w, h) {
  const sab = new SharedArrayBuffer(K.SH_HDR_BYTES + 2 * w * h * 4);
  const i32 = new Int32Array(sab);
  i32[K.SH_MAGIC] = K.SH_MAGIC_VALUE; i32[K.SH_W] = w; i32[K.SH_H] = h; i32[K.SH_GEN] = 1;
  return { sab, i32 };
}
function torn(shot) {
  // Every pixel byte must equal the first one (the producer fills a whole
  // buffer with one value per frame).
  const u32 = new Uint32Array(shot.rgba.buffer, shot.rgba.byteOffset, shot.rgba.length >> 2);
  const v = u32[0];
  for (let i = 1; i < u32.length; i++) if (u32[i] !== v) return true;
  return false;
}

async function run(locked, sid, sab, maxShots, stopWhenTorn) {
  const control = new SharedArrayBuffer(4);
  const worker = new Worker(__filename, { workerData: { sab, control, locked } });
  const done = new Promise((resolve, reject) => { worker.on('message', resolve); worker.on('error', reject); });
  // let the producer get going
  await new Promise((r) => setTimeout(r, 50));
  let tornN = 0, shots = 0, seqFirst = Atomics.load(new Int32Array(sab), K.SH_SEQ);
  const miss0 = kernel.shmLockMisses();
  for (; shots < maxShots; shots++) {
    if (torn(kernel.wmScreenshot(sid))) { tornN++; if (stopWhenTorn) { shots++; break; } }
    if ((shots & 15) === 0) await tick();       // let the kernel loop breathe
  }
  Atomics.store(new Int32Array(control), 0, 1);
  const stats = await done;
  await worker.terminate();
  const seqLast = Atomics.load(new Int32Array(sab), K.SH_SEQ);
  return { tornN, shots, frames: stats.frames, producerMisses: stats.misses,
           consumerMisses: kernel.shmLockMisses() - miss0, seqAdvanced: seqLast - seqFirst };
}

(async () => {
  await kernel.boot({ path: '/bin/init' });
  const r = await rpc(1, K.OP.SPAWN, { path: '/bin/app', argv: ['app'], envp: [], actions: [], flags: 0 });
  const app = r.pid;
  const fbA = makeFb(W, H);
  workers.get(app).msg({ type: 'wm-sabs', fb: fbA.sab, ring: null });
  const cA = await rpc(app, K.OP.SURFACE_CREATE, { w: W, h: H, title: 'locked', flags: 0 });
  const fbB = makeFb(W, H);
  workers.get(app).msg({ type: 'wm-sabs', fb: fbB.sab, ring: null });
  const cB = await rpc(app, K.OP.SURFACE_CREATE, { w: W, h: H, title: 'unlocked', flags: 0 });
  check('two surfaces created', !cA.errno && !cB.errno);

  // ---- GREEN: locked producer vs the kernel's locked read ----
  const g = await run(true, cA.sid, fbA.sab, 400, false);
  check('producer really ran concurrently (' + g.frames + ' frames, seq +' + g.seqAdvanced + ')', g.frames > 100 && g.seqAdvanced > 100);
  check('ZERO torn screenshots under the lock (' + g.shots + ' reads)', g.tornN === 0, 'torn=' + g.tornN);
  check('no lock misses on either side', g.producerMisses === 0 && g.consumerMisses === 0, JSON.stringify(g));
  check('SH_LOCK is free afterwards', Atomics.load(fbA.i32, K.SH_LOCK) === 0);

  // ---- RED CONTROL: the pre-#790 flip (no lock) must tear ----
  const c = await run(false, cB.sid, fbB.sab, 4000, true);
  check('RED CONTROL: an unlocked producer tears the kernel read (' + c.tornN + ' torn in ' + c.shots + ' reads, ' + c.frames + ' frames)',
    c.tornN > 0, JSON.stringify(c));

  console.log(failures ? `\ntest_shm_ownership: ${failures} FAILED` : '\ntest_shm_ownership: all passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
