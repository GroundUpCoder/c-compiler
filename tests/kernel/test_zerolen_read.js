#!/usr/bin/env node
// 0253 — kernel-brokered zero-length reads must return 0 immediately, never
// park. POSIX read(fd, buf, 0) does no data transfer and returns 0 at once;
// the 0252 R1 class fixed this on the host.js side, but the kernel-brokered
// path still parked count-0 reads on an empty stream with a live writer
// (_streamRead's `avail > 0` check for pipes/sockets/pty-master, and the tty
// FS_READ branch that queued a `ttyread` waiter regardless of count).
//
// This drives the raw kernel-page protocol with fake workers (test_pipes.js /
// test_pty.js / test_sockets.js pattern — no wasm) and asserts, for EVERY
// brokered read kind with an empty stream and a LIVE writer:
//   - a count===0 FS_READ returns immediately (not pending), 0 bytes;
//   - a count>0 FS_READ on the same empty stream still DEFERS (unchanged
//     blocking semantics — the fix is scoped to count===0).
//
// Run: node tests/kernel/test_zerolen_read.js
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

// ---- fake worker plumbing (same shape as test_pipes.js) ----
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
const spawnReq = (p, extra) => Object.assign(
  { path: p, argv: [p], envp: null, cwd: null, actions: [], flags: 0, pgid: 0 }, extra);

// A zero-length read on `fd` (empty stream, live writer): must return AT ONCE
// with 0 bytes, no parking. Then prove a count>0 read on the same fd defers.
async function assertZeroLen(label, pid, fd) {
  const z = submit(pid, K.OP.FS_READ, { fd, count: 0 });
  await tick();
  check(label + ': count-0 read returns immediately (no park)', !z.pending());
  const r = await z.finish();
  check(label + ': count-0 read yields 0 bytes',
    r.raw !== undefined && r.raw.length === 0, JSON.stringify(r));
  // Sanity: the stream really is empty with a live writer — a count>0 read
  // parks, so the count-0 return above was the short-circuit, not stray data.
  const d = submit(pid, K.OP.FS_READ, { fd, count: 100 });
  await tick();
  check(label + ': count>0 read on the same empty stream still defers', d.pending());
  return d;   // caller wakes/cancels it
}

kfs.mkdir('/tmp', 0o777);   // AF_UNIX bind targets live here

(async () => {
  await kernel.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });

  // ---- pipe (stream): empty, write end still open (live writer) ----
  // A parked count>0 read must be woken by a DIFFERENT process (a process with
  // a deferred RPC in flight can't issue another), so the child reads the pipe
  // and init (pid 1) is the live writer.
  let r = await rpc(1, K.OP.PIPE_CREATE, {});
  const prfd = r.rfd, pwfd = r.wfd;
  check('pipe created', prfd === 3 && pwfd === 4, JSON.stringify(r));
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a'));   // inherits prfd + pwfd
  const preader = r.pid;
  let deferred = await assertZeroLen('pipe', preader, prfd);
  await wRpc(1, pwfd, Buffer.from('x'));       // init wakes the parked count>0 read
  r = await deferred.finish();
  check('pipe: parked count>0 read still wakes on a real write',
    r.raw && r.raw.length === 1, JSON.stringify(r));

  // ---- socket (stream): connected pair, drained rx, live peer ----
  r = await rpc(1, K.OP.SOCK_SOCKET, {});
  const lfd = r.fd;
  await rpc(1, K.OP.SOCK_BIND, { fd: lfd, path: '/tmp/z.sock' });
  await rpc(1, K.OP.SOCK_LISTEN, { fd: lfd, backlog: 2 });
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a'));
  const cpid = r.pid;
  r = await rpc(cpid, K.OP.SOCK_SOCKET, {});
  const cfd = r.fd;
  await rpc(cpid, K.OP.SOCK_CONNECT, { fd: cfd, path: '/tmp/z.sock' });
  r = await rpc(1, K.OP.SOCK_ACCEPT, { fd: lfd });
  const afd = r.fd;
  check('socket pair connected', typeof afd === 'number', JSON.stringify(r));
  // Client rx is empty; the server end (afd) is the live writer.
  deferred = await assertZeroLen('socket', cpid, cfd);
  await wRpc(1, afd, Buffer.from('y'));        // peer write wakes the count>0 read
  r = await deferred.finish();
  check('socket: parked count>0 read still wakes on a peer write',
    r.raw && r.raw.length === 1, JSON.stringify(r));

  // ---- pty master (ptm, stream) + pty slave (tty) ----
  r = await rpc(1, K.OP.PTY_CREATE, {});
  const mfd = r.mfd, sfd = r.sfd;
  check('pty pair created', typeof mfd === 'number' && typeof sfd === 'number', JSON.stringify(r));
  // Master output is empty; the slave is the live writer (slave writes flow
  // to the master through OPOST). Spawn a child on the slave so it has a fg
  // pgroup — the count-0 tty read must skip the SIGTTIN/park path entirely.
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', {
    actions: [{ op: 0, fd: 0, arg: sfd }, { op: 0, fd: 1, arg: sfd }, { op: 0, fd: 2, arg: sfd }],
  }));
  const shpid = r.pid;
  check('pty child spawned on the slave', typeof shpid === 'number', JSON.stringify(r));

  // pty master: empty output, slave (fd 1 on the child) is the live writer.
  deferred = await assertZeroLen('pty master', 1, mfd);
  await wRpc(shpid, 1, Buffer.from('z\n'));     // slave write wakes the master read
  r = await deferred.finish();
  check('pty master: parked count>0 read still wakes on a slave write',
    r.raw && r.raw.length > 0, JSON.stringify(r));

  // pty slave (tty): no cooked bytes, master (mfd) is the live writer. Child
  // is the fg process, so a count>0 read parks as a ttyread waiter; count-0
  // short-circuits before that.
  const zt = submit(shpid, K.OP.FS_READ, { fd: 0, count: 0 });
  await tick();
  check('tty: count-0 read returns immediately (no park)', !zt.pending());
  r = await zt.finish();
  check('tty: count-0 read yields 0 bytes',
    r.raw !== undefined && r.raw.length === 0, JSON.stringify(r));
  const dt = submit(shpid, K.OP.FS_READ, { fd: 0, count: 100 });
  await tick();
  check('tty: count>0 read on the empty tty still defers', dt.pending());
  await wRpc(1, mfd, Buffer.from('go\r'));       // master write cooks a line, wakes it
  r = await dt.finish();
  check('tty: parked count>0 read still wakes on a master write',
    r.raw && r.raw.length > 0, JSON.stringify(r));

  console.log(failures ? `\nFAILED (${failures})` : '\nAll zero-length-read checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
