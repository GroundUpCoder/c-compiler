#!/usr/bin/env node
// #789 deterministic lifecycle kernel RPC tests; fake workers, no manual/browser evidence.
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
  return out;
}
const px = (shot, x, y) => Array.from(shot.rgba.subarray((y * shot.w + x) * 4, (y * shot.w + x) * 4 + 4));

(async () => {
  await kernel.boot({ path: '/bin/init' });
  const app = (await rpc(1, K.OP.SPAWN, { path:'/bin/app', argv:[], envp:[], actions:[], flags:0 })).pid;
  const ring = makeRing(256);
  async function create(flags = 0, extra = {}) {
    const fb = makeFb(80, 48); present(fb, [211, 31, 171, 255]);
    workers.get(app).msg({ type:'wm-sabs', fb:fb.sab, ring:ring.sab });
    return (await rpc(app, K.OP.SURFACE_CREATE, {w:80,h:48,title:'lifecycle',flags,...extra})).sid;
  }
  const visible = await create();
  const baseline = kernel.wmScreenshotScreen().rgba;
  const hidden = await create(256);
  const surf = kernel._surfaces.get(hidden), sab = surf.sab;
  check('hidden creation retains real storage', !!sab && surf.requestedVisible === false);
  check('hidden creation does not steal focus', kernel._focusSid === visible);
  check('hidden frame does not enter composition', Buffer.from(baseline).equals(Buffer.from(kernel.wmScreenshotScreen().rgba)));
  check('browser scene excludes hidden frame', !kernel.wmScene().surfaces.some(s=>s.sid===hidden));
  check('hidden target rejects keyboard injection', kernel.wmInjectKey(hidden,true,4,97,0)==='EACCES');
  check('hidden target rejects pointer injection', kernel.wmInjectPointer(hidden,'down',1,1)==='EACCES');
  check('wrong-owner hide rejected', (await rpc(1,K.OP.SURFACE_SET_VISIBLE,{sid:visible,visible:false})).errno==='EPERM');
  check('wrong-owner activation rejected', (await rpc(1,K.OP.SURFACE_ACTIVATE,{sid:visible})).errno==='EPERM');
  check('hidden activation rejected', (await rpc(app,K.OP.SURFACE_ACTIVATE,{sid:hidden})).errno==='EACCES');
  drain(ring);
  const flagsOf = sid => new DataView(kernel._wmpRecord(kernel._surfaces.get(sid)).buffer).getInt32(28,true);
  check('record exposes application-hidden state without viewable', (flagsOf(hidden)&256) && !(flagsOf(hidden)&512));
  await rpc(app,K.OP.SURFACE_SET_VISIBLE,{sid:hidden,visible:true});
  check('record exposes mapped visible state', !(flagsOf(hidden)&256) && (flagsOf(hidden)&512));
  check('show keeps sid and storage, without focus', surf.sab===sab && kernel._focusSid===visible);
  check('show emits one visibility event', drain(ring).filter(e=>e.type===0x202).length===1);
  await rpc(app,K.OP.SURFACE_SET_VISIBLE,{sid:hidden,visible:true});
  check('duplicate show is idempotent', drain(ring).length===0);
  await rpc(app,K.OP.SURFACE_ACTIVATE,{sid:hidden});
  check('explicit activation focuses in no-WM mode', kernel._focusSid===hidden);
  const popup = await create(64|128, {parentSid:hidden,dx:2,dy:2});
  await rpc(app,K.OP.SURFACE_SET_VISIBLE,{sid:hidden,visible:false});
  check('hide active window selects visible fallback', kernel._focusSid===visible);
  check('record suppresses viewable for hidden ancestor', !(flagsOf(popup)&512));
  check('popup hidden with parent', !kernel.wmScene().surfaces.some(s=>s.sid===popup));
  check('hide revokes popup grab', !kernel._wmGrabs.includes(popup));
  check('popup cannot receive hidden input', kernel.wmInjectPointer(popup,'down',1,1)==='EACCES');
  check('hide preserves popup resources', kernel._surfaces.has(popup));
  await rpc(app,K.OP.SURFACE_SET_VISIBLE,{sid:hidden,visible:true});
  check('show restores requested-visible descendants', kernel.wmScene().surfaces.some(s=>s.sid===popup));
  check('show restores surviving popup grab', kernel._wmGrabs.includes(popup));
  check('restored grab consumes outside press', kernel._wmGrabConsume(null,false)==='grab-dismiss');
  check('popup dismissal never starts watchdog', !kernel._surfaces.get(popup).closeWd);
  await rpc(app,K.OP.SURFACE_SET_VISIBLE,{sid:hidden,visible:false});
  await rpc(app,K.OP.SURFACE_SET_VISIBLE,{sid:hidden,visible:true});
  check('dismissed grab never resurrects on parent show', !kernel._wmGrabs.includes(popup));
  await rpc(app,K.OP.SURFACE_SET_VISIBLE,{sid:popup,visible:false});
  await rpc(app,K.OP.SURFACE_SET_VISIBLE,{sid:popup,visible:true});
  kernel.wmMinimize(hidden);
  check('record suppresses viewable for minimized root and popup', !(flagsOf(hidden)&512) && !(flagsOf(popup)&512));
  kernel._wmGrabConsume(null,false);
  kernel.wmFocus(hidden);
  check('minimize and outside click then restore retains popup grab', kernel._wmGrabs.includes(popup));
  kernel.wmFocus(visible);
  check('explicit popup reopening rearms dismissal', kernel._wmGrabConsume(null,false)==='grab-dismiss');
  // Capture placement timers deterministically, then exercise late callbacks.
  // No wall-clock nap: these are the actual callbacks registered by CREATE.
  const pending=[], emitted=[];
  const wm={pid:1,peer:{send(bytes){emitted.push(bytes);}}}; kernel._wmSubs.add(wm);
  const realSetTimeout=global.setTimeout;
  let delayed;
  try { global.setTimeout=(fn)=>{pending.push(fn);return {fake:true};}; delayed=await create(256); }
  finally { global.setTimeout=realSetTimeout; }
  const ds=kernel._surfaces.get(delayed); ds.mapTimer=null;
  check('WM managed hidden creation waits for placement', ds.mapped===false && pending.length===1);
  const earlyPopup = await create(64|128,{parentSid:delayed,dx:2,dy:2});
  await rpc(app,K.OP.SURFACE_SET_VISIBLE,{sid:delayed,visible:true});
  check('record suppresses viewable while placement pending', !(flagsOf(delayed)&512) && !(flagsOf(earlyPopup)&512));
  check('show before placement does not expose popup', !kernel.wmScene().surfaces.some(s=>s.sid===earlyPopup));
  kernel._wmGrabConsume(null,false); // outside press while parent is unmapped
  check('unmapped popup has no active dismissal grab', !kernel._wmGrabs.includes(earlyPopup));
  kernel.wmMove(delayed,190,170); pending[0]();
  check('placement restores pending popup grab', kernel._wmGrabs.includes(earlyPopup));
  await rpc(app,K.OP.SURFACE_SET_VISIBLE,{sid:delayed,visible:false});
  check('placement and stale timer cannot reveal hidden window', ds.mapped && !kernel.wmScene().surfaces.some(s=>s.sid===delayed));
  await rpc(app,K.OP.SURFACE_SET_VISIBLE,{sid:delayed,visible:true});
  const requestedEpoch=ds.visibilitySerial;
  await rpc(app,K.OP.SURFACE_ACTIVATE,{sid:delayed});
  check('activation request routed to WM, not implicit grant', kernel._focusSid===visible && emitted.some(b=>new DataView(b.buffer,b.byteOffset).getUint32(4,true)===K.WMP.EV_ACTIVATION_REQUEST));
  await rpc(app,K.OP.SURFACE_SET_VISIBLE,{sid:delayed,visible:false});
  check('late WM activation cannot undo hide', kernel.wmFocus(delayed)==='EACCES');
  const ov=new DataView(new ArrayBuffer(32));
  [1,delayed,10,10,80,48].forEach((v,i)=>ov.setInt32(8+4*i,v,true));
  kernel.wmOverviewSet(wm,ov,24);
  check('delayed overview cannot recreate hidden hit targets', !kernel._wmOverview);
  await rpc(app,K.OP.SURFACE_SET_VISIBLE,{sid:delayed,visible:true});
  check('old activation grant cannot focus a later show', kernel.wmFocus(delayed,requestedEpoch)==='EAGAIN');
  await rpc(app,K.OP.SURFACE_SET_VISIBLE,{sid:delayed,visible:false});
  check('popup activation rejected', (await rpc(app,K.OP.SURFACE_ACTIVATE,{sid:popup})).errno==='EINVAL');
  kernel._wmSubDrop(wm); pending[0]();
  check('last subscriber loss preserves explicit hide', !kernel.wmScene().surfaces.some(s=>s.sid===delayed));
  await rpc(app,K.OP.SURFACE_DESTROY,{sid:delayed}); pending[0]();
  check('stale timer after destroy cannot resurrect', !kernel._surfaces.has(delayed));
  check('stale lifecycle request fails', (await rpc(app,K.OP.SURFACE_SET_VISIBLE,{sid:delayed,visible:true})).errno==='EINVAL');
  await rpc(app,K.OP.SURFACE_DESTROY,{sid:hidden});
  check('destroy cascades popup', !kernel._surfaces.has(popup));
  await rpc(app,K.OP.SURFACE_DESTROY,{sid:visible});
  console.log('\nlifecycle: '+(failures?'FAIL '+failures:'PASS'));
  process.exitCode=failures?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
