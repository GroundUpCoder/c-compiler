#!/usr/bin/env node
// vDSO page semantics (todos/0179): kernel-written, process-read state
// PUBLISHED on the kernel page's tail behind one seqlock word instead of
// served over RPC (KERNEL.md "What may leave the kernel"). Fake-worker
// harness (test_kernel.js's): the kernel runs on THIS thread, so any
// KernelClient path that fell through to a real RPC would park forever —
// the client's call() is patched to record-and-return instead, which makes
// "zero RPCs" structurally provable: a vDSO read either answers from the
// page or shows up in the recorder.
//
// Covers: spawn-time publish (pid/ppid/pgid/sid/boot/screen), zero-RPC
// getpgid(0)/getsid(0)/self-pid, foreign-pid RPC fallback, SETPGID/SETSID
// republish, wmSetScreen fan-out to every live page, reparent-to-init ppid,
// the seqlock wedge -> RPC fallback, unpublished-page null, and the
// payload-cap arithmetic that keeps RPC payloads clear of the tail words.
//
// Run: node tests/kernel/test_vdso.js
'use strict';
const path = require('path');
const K = require(path.resolve(__dirname, '../../kernel.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}
const tick = () => new Promise((r) => setImmediate(r));

// ---- fake worker plumbing (test_kernel.js's) ----
const workers = new Map();
function createWorker(procSpec) {
  const h = {
    procSpec,
    msg: null,
    terminated: false,
    postMessage() {},
    onMessage(fn) { h.msg = fn; },
    onExit() {},
    terminate() { h.terminated = true; },
  };
  workers.set(procSpec.pid, h);
  return h;
}

const images = new Map([
  ['/bin/init', new Uint8Array([1])],
  ['/bin/a', new Uint8Array([2])],
]);

const kernel = new K.Kernel({
  createWorker,
  loadImage: (p) => images.get(p) || null,
  onOutput: () => {},
  onHalt: () => {},
  log: () => {},
});

function page(pid) {
  const pcb = kernel.process(pid);
  return { i32: new Int32Array(pcb.page), u8: new Uint8Array(pcb.page) };
}
async function rpc(pid, op, req) {
  const h = workers.get(pid);
  const { i32, u8 } = page(pid);
  K.writePayload(i32, u8, req);
  Atomics.store(i32, K.KP_RPC_OP, op);
  Atomics.store(i32, K.KP_RPC_STATE, K.RPC_REQUEST);
  h.msg({ type: 'krpc' });
  while (Atomics.load(i32, K.KP_RPC_STATE) !== K.RPC_DONE) await tick();
  const resp = K.readPayload(i32, u8);
  Atomics.store(i32, K.KP_RPC_STATE, K.RPC_IDLE);
  return resp;
}
const exitMsg = (pid, code) => workers.get(pid).msg({ type: 'exited', code });
const spawnReq = (p, extra) => Object.assign(
  { path: p, argv: [p], envp: null, cwd: null, actions: [], flags: 0, pgid: 0 }, extra);

// KernelClient with the RPC path fenced: falling through would deadlock the
// single-threaded harness, so record the op and answer with a sentinel.
function makeClient(pid) {
  const client = new K.KernelClient(kernel.process(pid).page, () => {});
  client.rpcOps = [];
  client.call = function (op) { client.rpcOps.push(op); return { errno: 'EFAKE' }; };
  return client;
}

(async () => {
  // ---- layout arithmetic ----
  check('payload cap stops 64 bytes short of the page',
    K.KP_PAYLOAD_CAP === K.KP_SIZE - K.KP_PAYLOAD_OFF - 64, String(K.KP_PAYLOAD_CAP));
  check('vDSO block sits past the payload region',
    K.KP_VD_SEQ * 4 >= K.KP_PAYLOAD_OFF + K.KP_PAYLOAD_CAP,
    K.KP_VD_SEQ * 4 + ' vs ' + (K.KP_PAYLOAD_OFF + K.KP_PAYLOAD_CAP));
  check('vDSO block sits below the vsync words',
    K.KP_VD_SCREEN_H < K.KP_VSYNC_ARMED);

  // ---- spawn-time publish ----
  await kernel.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });
  const p1 = page(1);
  const seq1 = Atomics.load(p1.i32, K.KP_VD_SEQ);
  check('page published at spawn (seq even, nonzero)', seq1 >= 2 && (seq1 & 1) === 0, String(seq1));
  check('published pid/ppid', Atomics.load(p1.i32, K.KP_VD_PID) === 1 &&
    Atomics.load(p1.i32, K.KP_VD_PPID) === 0);
  check('published pgid/sid', Atomics.load(p1.i32, K.KP_VD_PGID) === 1 &&
    Atomics.load(p1.i32, K.KP_VD_SID) === 1);

  const c1 = makeClient(1);
  const h1 = c1.spawnHooks();
  check('getpgid(0) answers from the page', h1.getpgid(0).pgid === 1, JSON.stringify(h1.getpgid(0)));
  check('getsid(0) answers from the page', h1.getsid(0).sid === 1);
  check('getpgid(own pid) answers from the page', h1.getpgid(1).pgid === 1);
  check('getsid(own pid) answers from the page', h1.getsid(1).sid === 1);
  check('zero RPCs so far', c1.rpcOps.length === 0, JSON.stringify(c1.rpcOps));
  check('foreign pid falls back to the RPC',
    h1.getpgid(999).errno === 'EFAKE' && c1.rpcOps.length === 1 && c1.rpcOps[0] === K.OP.GETPGID);
  c1.rpcOps.length = 0;

  check('getppid() reads the page', c1.getppid() === 0, String(c1.getppid()));
  const bootPub = (Atomics.load(p1.i32, K.KP_VD_BOOT_HI) >>> 0) * 4294967296 +
    (Atomics.load(p1.i32, K.KP_VD_BOOT_LO) >>> 0);
  check('published boot instant matches the kernel clock', bootPub === kernel._bootMs,
    bootPub + ' vs ' + kernel._bootMs);
  const up = c1.uptimeMs();
  check('uptimeMs() is sane', up !== null && up >= 0 && up < 60000, String(up));
  const scr0 = c1.screen();
  check('screen() reads the ctor default',
    scr0 && scr0.w === kernel._wmScreen.w && scr0.h === kernel._wmScreen.h, JSON.stringify(scr0));

  // ---- mutations republish ----
  let r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a'));
  check('spawn -> pid 2', r.pid === 2, JSON.stringify(r));
  const c2 = makeClient(2);
  const h2 = c2.spawnHooks();
  check('child inherits pgid 1 on its page', h2.getpgid(0).pgid === 1);
  check('child ppid on its page', c2.getppid() === 1);

  r = await rpc(2, K.OP.SETSID, {});
  check('setsid -> sid 2', r.sid === 2, JSON.stringify(r));
  check('setsid republished sid', h2.getsid(0).sid === 2);
  check('setsid republished pgid', h2.getpgid(0).pgid === 2);
  check('still zero RPCs on the child client', c2.rpcOps.length === 0);

  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a'));
  check('spawn -> pid 3', r.pid === 3);
  const c3 = makeClient(3);
  r = await rpc(1, K.OP.SETPGID, { pid: 3, pgid: 0 });
  check('parent setpgid ok', !r.errno, JSON.stringify(r));
  check('SETPGID republished on the TARGET page', c3.spawnHooks().getpgid(0).pgid === 3);

  // ---- wmSetScreen fans out to every live page ----
  kernel.wmSetScreen(800, 500);
  check('screen fan-out: pid 1', JSON.stringify(c1.screen()) === '{"w":800,"h":500}', JSON.stringify(c1.screen()));
  check('screen fan-out: pid 3', JSON.stringify(c3.screen()) === '{"w":800,"h":500}');

  // ---- reparent-to-init updates ppid ----
  r = await rpc(2, K.OP.SPAWN, spawnReq('/bin/a'));
  check('grandchild spawned by 2', r.pid === 4, JSON.stringify(r));
  const c4 = makeClient(4);
  check('grandchild ppid is 2', c4.getppid() === 2);
  exitMsg(2, 0);
  await tick();
  check('reparent republished ppid = 1', c4.getppid() === 1, String(c4.getppid()));

  // ---- seqlock wedge -> bounded spin -> RPC fallback ----
  const saved = Atomics.load(p1.i32, K.KP_VD_SEQ);
  Atomics.store(p1.i32, K.KP_VD_SEQ, saved + 1);       // odd: write "in progress"
  check('wedged page: reader gives null', c1._vdsoRead([K.KP_VD_PID]) === null);
  const wedged = h1.getpgid(0);
  check('wedged page: getpgid falls back to the RPC',
    wedged.errno === 'EFAKE' && c1.rpcOps[c1.rpcOps.length - 1] === K.OP.GETPGID);
  check('wedged page: getppid() gives null (caller keeps its static)', c1.getppid() === null);
  Atomics.store(p1.i32, K.KP_VD_SEQ, saved);           // even again
  c1.rpcOps.length = 0;
  check('restored page answers again, zero RPC',
    h1.getpgid(0).pgid === 1 && c1.rpcOps.length === 0);

  // ---- unpublished page (a client no kernel ever stamped) ----
  const cRaw = new K.KernelClient(new SharedArrayBuffer(K.KP_SIZE), () => {});
  check('unpublished page: reader gives null', cRaw._vdsoRead([K.KP_VD_PID]) === null);
  check('unpublished page: getppid/uptime/screen give null',
    cRaw.getppid() === null && cRaw.uptimeMs() === null && cRaw.screen() === null);

  console.log(failures === 0 ? '\nvdso semantics: PASS' : `\nvdso semantics: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
