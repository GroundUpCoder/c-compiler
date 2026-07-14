#!/usr/bin/env node
// SPSC pipe fast path (todos/0181) without wasm: fake workers over a
// brokered kernel, the test playing BOTH the process side of the kernel-page
// protocol AND the fast side of the ring (kernel.js exports the ring
// helpers, so the test's pipeRingPut/Take are byte-identical to RemoteFS's).
// Covered mechanics:
//   - the pipe-sab handshake: bytes live in the RING in every mode
//   - the mode ladder: LATENT at create (self-pipes never promote),
//     promotion on the parent's post-spawn closes, demotion on spawn
//     inheritance, strace pseudo-holder blocks promotion, in-process dup
//     does NOT demote
//   - procSpec.pipeRings ships the SAB to children at their post-action fds
//   - stale-mode contract: the kernel serves brokered ops on a FAST pipe
//     from the same ring
//   - the suppressed doorbell: parks raise PR_RWAIT/PR_WWAIT, PIPE_KICK
//     re-serves, _cancelWaiter clears; EOF/EPIPE latch PRF_WGONE/PRF_RGONE
//     and PIPE_KICK{epipe:1} deals the writer its SIGPIPE
//
// Run: node tests/kernel/test_pipes_spsc.js
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

// ---- fake worker plumbing (test_pipes.js pattern) ----
const workers = new Map();
function createWorker(procSpec) {
  const h = {
    procSpec,
    msg: null,
    terminated: false,
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
  ['/bin/a', new Uint8Array([2])],
]);

const store = new BLOCK_FS.MemoryByteStore(1 << 20);
const kfs = BLOCK_FS.createV4(store);
const kernel = new K.Kernel({
  fs: kfs,
  createWorker,
  loadImage: (p) => images.get(p) || null,
  onHalt: () => {},
  log: () => {},
});

function page(pid) {
  const pcb = kernel.process(pid);
  return { i32: new Int32Array(pcb.page), u8: new Uint8Array(pcb.page) };
}
function submit(pid, op, req, raw) {
  const h = workers.get(pid);
  const { i32, u8 } = page(pid);
  if (raw) K.writeRawPayload(i32, u8, req); else K.writePayload(i32, u8, req);
  Atomics.store(i32, K.KP_RPC_OP, op);
  Atomics.store(i32, K.KP_RPC_STATE, K.RPC_REQUEST);
  h.msg({ type: 'krpc' });
  return {
    pending: () => Atomics.load(i32, K.KP_RPC_STATE) !== K.RPC_DONE,
    async finish() {
      while (Atomics.load(i32, K.KP_RPC_STATE) !== K.RPC_DONE) await tick();
      const resp = K.readPayload(i32, u8);
      Atomics.store(i32, K.KP_RPC_STATE, K.RPC_IDLE);
      return resp;
    },
  };
}
const rpc = (pid, op, req) => submit(pid, op, req).finish();
function writeReq(fd, bytes) {
  const p = new Uint8Array(4 + bytes.length);
  p[0] = fd & 0xff; p[1] = (fd >> 8) & 0xff; p[2] = (fd >> 16) & 0xff; p[3] = (fd >> 24) & 0xff;
  p.set(bytes, 4);
  return p;
}
const wRpc = (pid, fd, bytes) => submit(pid, K.OP.FS_WRITE, writeReq(fd, bytes), true).finish();
const str = (b) => Buffer.from(b).toString();
const spawnReq = (p, extra) => Object.assign(
  { path: p, argv: [p], envp: null, cwd: null, actions: [], flags: 0, pgid: 0 }, extra);

// A ringed pipe for pid: post the SAB, create, return fds + our own views.
async function ringedPipe(pid) {
  const sab = new SharedArrayBuffer(K.PIPE_RING_BYTES);
  workers.get(pid).msg({ type: 'pipe-sab', sab });
  const r = await rpc(pid, K.OP.PIPE_CREATE, {});
  return { rfd: r.rfd, wfd: r.wfd, ring: K.pipeRingViews(sab) };
}
const mode = (p) => Atomics.load(p.ring.i32, K.PR_MODE);
const flags = (p) => Atomics.load(p.ring.i32, K.PR_FLAGS);

(async () => {
  await kernel.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });

  // ---- ringed create: LATENT, bytes live in the ring either way ----
  let p = await ringedPipe(1);
  check('ringed pipe created', p.rfd === 3 && p.wfd === 4, JSON.stringify(p));
  check('mode at create is LATENT (self-pipes never promote)', mode(p) === K.PR_LATENT);
  let r = await wRpc(1, p.wfd, Buffer.from('ringbytes'));
  check('brokered write accepted', r.n === 9, JSON.stringify(r));
  check('...and landed IN THE RING', K.pipeRingAvail(p.ring) === 9);
  r = await rpc(1, K.OP.FS_READ, { fd: p.rfd, count: 100 });
  check('brokered read drains the ring', r.raw && str(r.raw) === 'ringbytes', JSON.stringify(r));
  check('ring empty after read', K.pipeRingAvail(p.ring) === 0);
  check('self-pipe traffic never promoted it', mode(p) === K.PR_LATENT);

  // ---- the hush pipeline shape: spawn writer + reader, parent closes ----
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', {
    actions: [{ op: 0, fd: 1, arg: p.wfd }, { op: 2, fd: p.rfd }, { op: 2, fd: p.wfd }],
  }));
  const A = r.pid;   // writer: pipe write end at fd 1
  check('writer spawned', A === 2, JSON.stringify(r));
  check('writer procSpec ships the ring at its post-action fd',
    (workers.get(A).procSpec.pipeRings || []).some(
      (e) => e.fd === 1 && e.end === 'write' && e.sab === p.ring.sab),
    JSON.stringify(workers.get(A).procSpec.pipeRings));
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', {
    actions: [{ op: 0, fd: 0, arg: p.rfd }, { op: 2, fd: p.rfd }, { op: 2, fd: p.wfd }],
  }));
  const B = r.pid;   // reader: pipe read end at fd 0
  check('reader procSpec ships the ring too',
    (workers.get(B).procSpec.pipeRings || []).some(
      (e) => e.fd === 0 && e.end === 'read' && e.sab === p.ring.sab),
    JSON.stringify(workers.get(B).procSpec.pipeRings));
  check('still LATENT while the parent holds both ends', mode(p) === K.PR_LATENT);
  await rpc(1, K.OP.FS_CLOSE, { fd: p.wfd });
  check('...and after the first close', mode(p) === K.PR_LATENT);
  await rpc(1, K.OP.FS_CLOSE, { fd: p.rfd });
  check('PROMOTED once each end is single-holder', mode(p) === K.PR_FAST);

  // ---- stale-mode contract: brokered ops on a FAST pipe use the ring ----
  K.pipeRingPut(p.ring, Buffer.from('fastlane'));   // the test plays A's fast write
  r = await rpc(B, K.OP.FS_READ, { fd: 0, count: 100 });
  check('kernel serves a brokered read on a FAST pipe from the ring',
    r.raw && str(r.raw) === 'fastlane', JSON.stringify(r));

  // ---- suppressed doorbell: park raises PR_RWAIT, PIPE_KICK re-serves ----
  const dr = submit(B, K.OP.FS_READ, { fd: 0, count: 100 });
  await tick();
  check('empty-ring read parks', dr.pending());
  check('...and raises PR_RWAIT', Atomics.load(p.ring.i32, K.PR_RWAIT) === 1);
  K.pipeRingPut(p.ring, Buffer.from('kicked'));     // A commits...
  r = await rpc(A, K.OP.PIPE_KICK, { fd: 1 });      // ...sees the flag, rings
  check('kick accepted', !r.errno, JSON.stringify(r));
  r = await dr.finish();
  check('parked read served by the kick', r.raw && str(r.raw) === 'kicked', JSON.stringify(r));
  check('PR_RWAIT cleared with the waiter', Atomics.load(p.ring.i32, K.PR_RWAIT) === 0);

  // ---- FS_WAIT names a fast pipe fd (the 0178 park, ring-aware scan) ----
  const dw = submit(B, K.OP.FS_WAIT, { r: [0], timeoutMs: null });
  await tick();
  check('FS_WAIT on the empty fast pipe parks', dw.pending());
  check('...and raises PR_RWAIT', Atomics.load(p.ring.i32, K.PR_RWAIT) === 1);
  K.pipeRingPut(p.ring, Buffer.from('x'));
  await rpc(A, K.OP.PIPE_KICK, { fd: 1 });
  r = await dw.finish();
  check('FS_WAIT wakes fd-ready', r.why === 1 && r.r && r.r.includes(0), JSON.stringify(r));
  // B drains fast (test-played) and kicks nobody (no writer parked).
  check('fast drain', str(K.pipeRingTake(p.ring, 1)) === 'x');

  // ---- FS_SELECT read-readiness comes off the ring ----
  K.pipeRingPut(p.ring, Buffer.from('sel'));
  r = await rpc(B, K.OP.FS_SELECT, { r: [0], w: [], timeoutMs: 0 });
  check('select sees ring data', r.r && r.r.includes(0), JSON.stringify(r));
  K.pipeRingTake(p.ring, 3);

  // ---- writer side: full ring parks the (stale-mode) write, WWAIT up ----
  const cap = p.ring.cap;
  K.pipeRingPut(p.ring, Buffer.alloc(cap));         // A fast-fills the ring
  const dW = submit(A, K.OP.FS_WRITE, writeReq(1, Buffer.from('parked')), true);
  await tick();
  check('write against the full ring parks', dW.pending());
  check('...and raises PR_WWAIT', Atomics.load(p.ring.i32, K.PR_WWAIT) === 1);
  K.pipeRingTake(p.ring, cap);                      // B fast-drains...
  await rpc(B, K.OP.PIPE_KICK, { fd: 0 });          // ...sees WWAIT, rings
  r = await dW.finish();
  check('parked write served after the drain-kick', r.n === 6, JSON.stringify(r));
  check('PR_WWAIT cleared', Atomics.load(p.ring.i32, K.PR_WWAIT) === 0);
  check('the parked bytes landed in the ring', str(K.pipeRingTake(p.ring, 6)) === 'parked');

  // ---- in-process dup does NOT demote (same holder) ----
  r = await rpc(A, K.OP.FS_DUP, { fd: 1 });
  check('dup of the fast write end', r.fd >= 0, JSON.stringify(r));
  check('still FAST (one holder, two fds)', mode(p) === K.PR_FAST);
  await rpc(A, K.OP.FS_CLOSE, { fd: r.fd });

  // ---- EOF: closing the last write end latches PRF_WGONE ----
  const dE = submit(B, K.OP.FS_READ, { fd: 0, count: 10 });
  await tick();
  check('reader parked for the EOF leg', dE.pending());
  await rpc(A, K.OP.FS_CLOSE, { fd: 1 });           // the LAST write end
  check('PRF_WGONE latched for the fast reader', (flags(p) & K.PRF_WGONE) !== 0);
  r = await dE.finish();
  check('parked reader got EOF', r.raw && r.raw.length === 0, JSON.stringify(r));
  workers.get(B).msg({ type: 'exited', code: 0 });
  await rpc(1, K.OP.WAIT, { pid: B, options: 0 });
  workers.get(A).msg({ type: 'exited', code: 0 });
  await rpc(1, K.OP.WAIT, { pid: A, options: 0 });

  // ---- EPIPE: reader gone latches PRF_RGONE; kick{epipe} deals SIGPIPE ----
  p = await ringedPipe(1);
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', {
    actions: [{ op: 0, fd: 1, arg: p.wfd }, { op: 2, fd: p.rfd }, { op: 2, fd: p.wfd }],
  }));
  const W = r.pid;   // writer only
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', {
    actions: [{ op: 0, fd: 0, arg: p.rfd }, { op: 2, fd: p.rfd }, { op: 2, fd: p.wfd }],
  }));
  const R2 = r.pid;  // reader only
  await rpc(1, K.OP.FS_CLOSE, { fd: p.rfd });
  await rpc(1, K.OP.FS_CLOSE, { fd: p.wfd });
  check('second pipeline promoted', mode(p) === K.PR_FAST);
  await rpc(R2, K.OP.FS_CLOSE, { fd: 0 });          // reader closes: RGONE
  workers.get(R2).msg({ type: 'exited', code: 0 });
  await rpc(1, K.OP.WAIT, { pid: R2, options: 0 });
  check('PRF_RGONE latched for the fast writer', (flags(p) & K.PRF_RGONE) !== 0);
  r = await rpc(W, K.OP.PIPE_KICK, { fd: 1, epipe: 1 });
  check('epipe kick answered', !r.errno, JSON.stringify(r));
  check('SIGPIPE at DFL terminated the writer', kernel.process(W).state === 'zombie');
  r = await rpc(1, K.OP.WAIT, { pid: W, options: 0 });
  check('writer waits as WTERMSIG SIGPIPE', r.status === 13, JSON.stringify(r));

  // ---- demotion: spawn-inheriting a FAST end flips DEMOTED, one-way ----
  p = await ringedPipe(1);
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', {
    actions: [{ op: 0, fd: 1, arg: p.wfd }, { op: 2, fd: p.rfd }, { op: 2, fd: p.wfd }],
  }));
  const A3 = r.pid;
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', {
    actions: [{ op: 0, fd: 0, arg: p.rfd }, { op: 2, fd: p.rfd }, { op: 2, fd: p.wfd }],
  }));
  const B3 = r.pid;
  await rpc(1, K.OP.FS_CLOSE, { fd: p.rfd });
  await rpc(1, K.OP.FS_CLOSE, { fd: p.wfd });
  check('third pipeline promoted', mode(p) === K.PR_FAST);
  K.pipeRingPut(p.ring, Buffer.from('pre'));        // fast bytes in flight
  r = await rpc(A3, K.OP.SPAWN, spawnReq('/bin/a'));  // full inherit: fd 1 shared
  const C3 = r.pid;
  check('spawn-inherited write end DEMOTES', mode(p) === K.PR_DEMOTED);
  check('the child procSpec still ships the ring (mode word gates it)',
    (workers.get(C3).procSpec.pipeRings || []).some((e) => e.fd === 1 && e.end === 'write'),
    JSON.stringify(workers.get(C3).procSpec.pipeRings));
  r = await wRpc(C3, 1, Buffer.from('+post'));
  check('brokered write from the new holder appends after the fast bytes', r.n === 5);
  r = await rpc(B3, K.OP.FS_READ, { fd: 0, count: 100 });
  check('reader sees fast-then-brokered bytes in order',
    r.raw && str(r.raw) === 'pre+post', JSON.stringify(r));
  await rpc(A3, K.OP.FS_CLOSE, { fd: 1 });
  workers.get(C3).msg({ type: 'exited', code: 0 });
  check('demotion is one-way: back to one holder per end but NOT FAST',
    mode(p) === K.PR_DEMOTED);

  // ---- strace: the kernel's trace ref is a pseudo-holder, never FAST ----
  p = await ringedPipe(1);
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', {
    flags: 2, trace: p.wfd,
    actions: [{ op: 2, fd: p.rfd }, { op: 2, fd: p.wfd }],
  }));
  const T = r.pid;
  check('tracee spawned', T > 0, JSON.stringify(r));
  await rpc(1, K.OP.FS_CLOSE, { fd: p.wfd });       // tracer's own copy gone
  check('trace pipe stays LATENT (kernel pseudo-holder blocks promotion)',
    mode(p) === K.PR_LATENT);
  await rpc(T, K.OP.FS_GETCWD, {});                 // any tracee RPC emits a line
  r = await rpc(1, K.OP.FS_READ, { fd: p.rfd, count: 4096 });
  check('trace lines flow through the ring brokered',
    r.raw && str(r.raw).includes('FS_GETCWD'), JSON.stringify(r && r.raw && str(r.raw)));

  console.log(failures === 0 ? '\nspsc pipes: PASS' : `\nspsc pipes: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
