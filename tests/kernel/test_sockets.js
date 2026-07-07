#!/usr/bin/env node
// AF_UNIX socket semantics (todos/0008) without wasm: fake workers over a
// BROKERED kernel, the test playing the process side of the kernel-page
// protocol (test_pipes.js pattern — see there and test_kernel.js for the
// plumbing rationale). Protocol rule the test respects: a process with a
// deferred RPC in flight is parked and cannot issue another one — triggers
// come from a DIFFERENT process or the embedder-facing kernel.kill().
//
// Run: node tests/kernel/test_sockets.js
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
const wDefer = (pid, fd, bytes) => submit(pid, K.OP.FS_WRITE, writeReq(fd, bytes), true);
const str = (b) => Buffer.from(b).toString();
const spawnReq = (p, extra) => Object.assign(
  { path: p, argv: [p], envp: null, cwd: null, actions: [], flags: 0, pgid: 0 }, extra);
const exitPid = async (pid) => {
  workers.get(pid).msg({ type: 'exited', code: 0 });
  await rpc(1, K.OP.WAIT, { pid: pid, options: 0 });
};

(async () => {
  await kernel.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });
  kfs.mkdir('/tmp', 0o777);
  // init writes into dead peers below; at DFL that SIGPIPE would kill pid 1
  // and halt the system mid-test.
  await rpc(1, K.OP.SIGDISP, { sig: 13, kind: 1 /* IGN */ });
  const baselineOfds = kernel._ofds.size;   // the lazy std triple

  // ---- create / fstat / state errors on a fresh socket ----
  let r = await rpc(1, K.OP.SOCK_SOCKET, {});
  check('socket lands past stdio fds', r.fd === 3, JSON.stringify(r));
  const sfd = r.fd;
  r = await rpc(1, K.OP.FS_FSTAT, { fd: sfd });
  check('fstat says S_IFSOCK', r.st && (r.st.mode & 0xF000) === 0xC000, JSON.stringify(r));
  r = await rpc(1, K.OP.FS_READ, { fd: sfd, count: 10 });
  check('read on unconnected socket -> ENOTCONN', r.errno === 'ENOTCONN', JSON.stringify(r));
  r = await wRpc(1, sfd, Buffer.from('x'));
  check('write on unconnected socket -> ENOTCONN', r.errno === 'ENOTCONN', JSON.stringify(r));
  r = await rpc(1, K.OP.SOCK_LISTEN, { fd: sfd, backlog: 4 });
  check('listen before bind -> EDESTADDRREQ', r.errno === 'EDESTADDRREQ', JSON.stringify(r));
  r = await rpc(1, K.OP.SOCK_ACCEPT, { fd: sfd });
  check('accept on non-listener -> EINVAL', r.errno === 'EINVAL', JSON.stringify(r));
  r = await rpc(1, K.OP.SOCK_BIND, { fd: 0, path: '/tmp/nope' });
  check('bind on a non-socket fd -> ENOTSOCK', r.errno === 'ENOTSOCK', JSON.stringify(r));

  // ---- bind: a real S_IFSOCK node; EADDRINUSE; open() refuses it ----
  r = await rpc(1, K.OP.SOCK_BIND, { fd: sfd, path: '/tmp/srv.sock' });
  check('bind succeeds', !r.errno, JSON.stringify(r));
  const st = kfs.stat('/tmp/srv.sock');
  check('socket node exists as S_IFSOCK', st && (st.mode & 0o170000) === 0o140000,
    st && st.mode.toString(8));
  r = await rpc(1, K.OP.SOCK_BIND, { fd: sfd, path: '/tmp/other.sock' });
  check('rebinding a bound socket -> EINVAL', r.errno === 'EINVAL', JSON.stringify(r));
  r = await rpc(1, K.OP.SOCK_SOCKET, {});
  const sfd2 = r.fd;
  r = await rpc(1, K.OP.SOCK_BIND, { fd: sfd2, path: '/tmp/srv.sock' });
  check('bind to a taken path -> EADDRINUSE', r.errno === 'EADDRINUSE', JSON.stringify(r));
  r = await rpc(1, K.OP.FS_OPEN, { path: '/tmp/srv.sock', flags: 0, mode: 0 });
  check('open() on a socket node -> ENXIO', r.errno === 'ENXIO', JSON.stringify(r));

  // ---- connect errors: not listening / missing / not a socket ----
  r = await rpc(1, K.OP.SOCK_CONNECT, { fd: sfd2, path: '/tmp/srv.sock' });
  check('connect before listen -> ECONNREFUSED', r.errno === 'ECONNREFUSED', JSON.stringify(r));
  r = await rpc(1, K.OP.SOCK_CONNECT, { fd: sfd2, path: '/tmp/missing.sock' });
  check('connect to a missing path -> ENOENT', r.errno === 'ENOENT', JSON.stringify(r));
  kfs.close(kfs.open('/tmp/regular', 0x40 /*O_CREAT*/, 0o644));
  r = await rpc(1, K.OP.SOCK_CONNECT, { fd: sfd2, path: '/tmp/regular' });
  check('connect to a regular file -> ECONNREFUSED', r.errno === 'ECONNREFUSED', JSON.stringify(r));

  // ---- listen + queued connect (connect completes BEFORE accept) ----
  r = await rpc(1, K.OP.SOCK_LISTEN, { fd: sfd, backlog: 2 });
  check('listen succeeds', !r.errno, JSON.stringify(r));
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a'));
  const cpid = r.pid;
  r = await rpc(cpid, K.OP.SOCK_SOCKET, {});
  const cfd = r.fd;
  r = await rpc(cpid, K.OP.SOCK_CONNECT, { fd: cfd, path: '/tmp/srv.sock' });
  check('connect to a listener succeeds without accept', !r.errno, JSON.stringify(r));
  r = await rpc(cpid, K.OP.SOCK_CONNECT, { fd: cfd, path: '/tmp/srv.sock' });
  check('second connect on the same fd -> EISCONN', r.errno === 'EISCONN', JSON.stringify(r));
  r = await wRpc(cpid, cfd, Buffer.from('early'));   // data buffered pre-accept
  check('client write before accept lands', r.n === 5, JSON.stringify(r));
  r = await rpc(1, K.OP.SOCK_ACCEPT, { fd: sfd });
  check('accept returns a new fd', typeof r.fd === 'number' && r.fd !== sfd, JSON.stringify(r));
  const afd = r.fd;
  r = await rpc(1, K.OP.FS_READ, { fd: afd, count: 100 });
  check('server reads pre-accept bytes', r.raw && str(r.raw) === 'early', JSON.stringify(r));

  // ---- bidirectional traffic + deferred read woken cross-process ----
  r = await wRpc(1, afd, Buffer.from('pong'));
  check('server -> client write', r.n === 4, JSON.stringify(r));
  r = await rpc(cpid, K.OP.FS_READ, { fd: cfd, count: 100 });
  check('client reads the reply', r.raw && str(r.raw) === 'pong', JSON.stringify(r));
  const dr = submit(cpid, K.OP.FS_READ, { fd: cfd, count: 100 });
  await tick();
  check('empty-socket read defers', dr.pending());
  await wRpc(1, afd, Buffer.from('wake'));
  r = await dr.finish();
  check('parked read woken by peer write', r.raw && str(r.raw) === 'wake', JSON.stringify(r));

  // ---- select readiness on connected sockets ----
  r = await rpc(1, K.OP.FS_SELECT, { r: [afd], w: [afd], timeoutMs: 0 });
  check('drained socket: not read-ready, write-ready',
    r.count === 1 && r.r.length === 0 && r.w.length === 1, JSON.stringify(r));
  const ds = submit(1, K.OP.FS_SELECT, { r: [afd], w: [], timeoutMs: null });
  await tick();
  check('select on idle socket defers', ds.pending());
  await wRpc(cpid, cfd, Buffer.from('sel'));
  r = await ds.finish();
  check('deferred select woken by peer write', r.count === 1 && r.r[0] === afd, JSON.stringify(r));
  await rpc(1, K.OP.FS_READ, { fd: afd, count: 100 });

  // ---- backpressure: full direction defers the writer, drain releases ----
  r = await wRpc(cpid, cfd, Buffer.alloc(60000, 65));
  check('big write lands whole', r.n === 60000, JSON.stringify(r));
  r = await wRpc(cpid, cfd, Buffer.alloc(6000, 66));
  check('write to nearly-full socket is partial', r.n === 5536, JSON.stringify(r));
  const dw = wDefer(cpid, cfd, Buffer.from('block'));
  await tick();
  check('write to full socket defers', dw.pending());
  r = await rpc(1, K.OP.FS_SELECT, { r: [], w: [afd], timeoutMs: 0 });
  check('reverse direction still write-ready while forward is full',
    r.w.length === 1, JSON.stringify(r));
  r = await rpc(1, K.OP.FS_READ, { fd: afd, count: 65536 });
  check('drain read (payload-cap clamped)', r.raw && r.raw.length === 65504,
    r.raw && r.raw.length);
  r = await dw.finish();
  check('parked write completes after drain', r.n === 5, JSON.stringify(r));
  r = await rpc(1, K.OP.FS_READ, { fd: afd, count: 65536 });
  check('tail preserves order', r.raw && r.raw.length === 32 + 5 &&
    str(r.raw.subarray(r.raw.length - 5)) === 'block', r.raw && r.raw.length);

  // ---- shutdown(SHUT_WR): peer EOF, own writes EPIPE ----
  r = await rpc(cpid, K.OP.SOCK_SHUTDOWN, { fd: cfd, how: 1 });
  check('shutdown(SHUT_WR) succeeds', !r.errno, JSON.stringify(r));
  r = await rpc(1, K.OP.FS_READ, { fd: afd, count: 10 });
  check('peer reads EOF after SHUT_WR', r.raw && r.raw.length === 0, JSON.stringify(r));
  r = await rpc(cpid, K.OP.SIGDISP, { sig: 13, kind: 1 /* IGN: survive EPIPE */ });
  r = await wRpc(cpid, cfd, Buffer.from('x'));
  check('write after own SHUT_WR -> EPIPE', r.errno === 'EPIPE', JSON.stringify(r));
  r = await wRpc(1, afd, Buffer.from('back'));
  check('reverse direction survives SHUT_WR', r.n === 4, JSON.stringify(r));
  r = await rpc(cpid, K.OP.FS_READ, { fd: cfd, count: 10 });
  check('client still reads the reverse direction', r.raw && str(r.raw) === 'back', JSON.stringify(r));

  // ---- close: peer sees EOF; write to closed peer EPIPE + SIGPIPE ----
  r = await rpc(cpid, K.OP.FS_CLOSE, { fd: cfd });
  check('client close', !r.errno, JSON.stringify(r));
  r = await rpc(1, K.OP.FS_READ, { fd: afd, count: 10 });
  check('server reads EOF after client close', r.raw && r.raw.length === 0, JSON.stringify(r));
  r = await wRpc(1, afd, Buffer.from('dead'));
  check('write to a closed peer -> EPIPE', r.errno === 'EPIPE', JSON.stringify(r));
  await rpc(1, K.OP.FS_CLOSE, { fd: afd });
  await exitPid(cpid);

  // ---- deferred accept served directly by a connect ----
  const da = submit(1, K.OP.SOCK_ACCEPT, { fd: sfd });
  await tick();
  check('accept with no pending defers', da.pending());
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a'));
  const cpid2 = r.pid;
  r = await rpc(cpid2, K.OP.SOCK_SOCKET, {});
  const cfd2 = r.fd;
  r = await rpc(cpid2, K.OP.SOCK_CONNECT, { fd: cfd2, path: '/tmp/srv.sock' });
  check('connect serves the parked accept', !r.errno, JSON.stringify(r));
  r = await da.finish();
  check('parked accept woke with a connection fd', typeof r.fd === 'number', JSON.stringify(r));
  const afd2 = r.fd;
  await wRpc(cpid2, cfd2, Buffer.from('direct'));
  r = await rpc(1, K.OP.FS_READ, { fd: afd2, count: 100 });
  check('direct-served connection carries data', r.raw && str(r.raw) === 'direct', JSON.stringify(r));
  await rpc(1, K.OP.FS_CLOSE, { fd: afd2 });
  await exitPid(cpid2);

  // ---- accept EINTR via krpc-intr ----
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a'));
  const ipid = r.pid;
  // The child needs its own listener (init cannot issue two RPCs at once).
  r = await rpc(ipid, K.OP.SOCK_SOCKET, {});
  const lfd = r.fd;
  await rpc(ipid, K.OP.SOCK_BIND, { fd: lfd, path: '/tmp/intr.sock' });
  await rpc(ipid, K.OP.SOCK_LISTEN, { fd: lfd, backlog: 1 });
  const di = submit(ipid, K.OP.SOCK_ACCEPT, { fd: lfd });
  await tick();
  check('accept parked for the EINTR test', di.pending());
  workers.get(ipid).msg({ type: 'krpc-intr' });
  r = await di.finish();
  check('krpc-intr answers EINTR on a parked accept', r.errno === 'EINTR', JSON.stringify(r));
  await exitPid(ipid);
  kfs.unlink('/tmp/intr.sock');

  // ---- select on a listener + backlog overflow ----
  r = await rpc(1, K.OP.FS_SELECT, { r: [sfd], w: [], timeoutMs: 0 });
  check('idle listener not read-ready', r.count === 0, JSON.stringify(r));
  // The child must NOT inherit the listener fd (a CLOSE action, like any
  // real spawner): an inherited copy would keep the listener alive past
  // init's close below — correct POSIX, wrong test.
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', { actions: [{ op: 2, fd: sfd }] }));
  const bpid = r.pid;
  r = await rpc(bpid, K.OP.SOCK_SOCKET, {});
  const b1 = r.fd;
  await rpc(bpid, K.OP.SOCK_CONNECT, { fd: b1, path: '/tmp/srv.sock' });
  r = await rpc(1, K.OP.FS_SELECT, { r: [sfd], w: [], timeoutMs: 0 });
  check('queued connection makes the listener read-ready', r.count === 1, JSON.stringify(r));
  r = await rpc(bpid, K.OP.SOCK_SOCKET, {});
  const b2 = r.fd;
  await rpc(bpid, K.OP.SOCK_CONNECT, { fd: b2, path: '/tmp/srv.sock' });
  r = await rpc(bpid, K.OP.SOCK_SOCKET, {});
  const b3 = r.fd;
  r = await rpc(bpid, K.OP.SOCK_CONNECT, { fd: b3, path: '/tmp/srv.sock' });
  check('backlog(2) overflow -> ECONNREFUSED', r.errno === 'ECONNREFUSED', JSON.stringify(r));
  r = await rpc(bpid, K.OP.SOCK_CONNECT, { fd: b3, path: '/tmp/srv.sock' });
  check('refused socket stays fresh and can retry (still full)', r.errno === 'ECONNREFUSED', JSON.stringify(r));

  // ---- listener close with queued pending: clients learn ----
  await rpc(1, K.OP.FS_CLOSE, { fd: sfd });
  r = await rpc(bpid, K.OP.FS_READ, { fd: b1, count: 10 });
  check('queued client reads EOF after listener close', r.raw && r.raw.length === 0, JSON.stringify(r));
  await rpc(bpid, K.OP.SIGDISP, { sig: 13, kind: 1 });
  r = await wRpc(bpid, b2, Buffer.from('x'));
  check('queued client write EPIPE after listener close', r.errno === 'EPIPE', JSON.stringify(r));
  r = await rpc(bpid, K.OP.SOCK_CONNECT, { fd: b3, path: '/tmp/srv.sock' });
  check('connect after listener close -> ECONNREFUSED', r.errno === 'ECONNREFUSED', JSON.stringify(r));
  await exitPid(bpid);

  // ---- rebind after unlink: fresh listener takes over the path ----
  kfs.unlink('/tmp/srv.sock');
  r = await rpc(1, K.OP.SOCK_CONNECT, { fd: sfd2, path: '/tmp/srv.sock' });
  check('connect after unlink -> ENOENT', r.errno === 'ENOENT', JSON.stringify(r));
  r = await rpc(1, K.OP.SOCK_BIND, { fd: sfd2, path: '/tmp/srv.sock' });
  check('rebind after unlink succeeds', !r.errno, JSON.stringify(r));
  await rpc(1, K.OP.SOCK_LISTEN, { fd: sfd2, backlog: 1 });
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a'));
  const rpid = r.pid;
  r = await rpc(rpid, K.OP.SOCK_SOCKET, {});
  r = await rpc(rpid, K.OP.SOCK_CONNECT, { fd: r.fd, path: '/tmp/srv.sock' });
  check('connect reaches the new listener', !r.errno, JSON.stringify(r));
  await exitPid(rpid);
  await rpc(1, K.OP.FS_CLOSE, { fd: sfd2 });
  kfs.unlink('/tmp/srv.sock');

  // ---- socketpair: bidirectional, dup sharing, EOF semantics ----
  r = await rpc(1, K.OP.SOCK_PAIR, {});
  check('socketpair returns two fds', typeof r.fd0 === 'number' && typeof r.fd1 === 'number',
    JSON.stringify(r));
  const p0 = r.fd0, p1 = r.fd1;
  await wRpc(1, p0, Buffer.from('ab'));
  r = await rpc(1, K.OP.FS_READ, { fd: p1, count: 10 });
  check('pair: 0 -> 1', r.raw && str(r.raw) === 'ab', JSON.stringify(r));
  await wRpc(1, p1, Buffer.from('cd'));
  r = await rpc(1, K.OP.FS_READ, { fd: p0, count: 10 });
  check('pair: 1 -> 0', r.raw && str(r.raw) === 'cd', JSON.stringify(r));
  r = await rpc(1, K.OP.FS_DUP, { fd: p1 });
  const p1dup = r.fd;
  await rpc(1, K.OP.FS_CLOSE, { fd: p1 });
  await wRpc(1, p0, Buffer.from('still'));
  r = await rpc(1, K.OP.FS_READ, { fd: p1dup, count: 10 });
  check('dup keeps the pair end alive past a close', r.raw && str(r.raw) === 'still',
    JSON.stringify(r));
  await rpc(1, K.OP.FS_CLOSE, { fd: p1dup });      // LAST reference to that end
  r = await rpc(1, K.OP.FS_READ, { fd: p0, count: 10 });
  check('EOF once the last dup of the peer closes', r.raw && r.raw.length === 0,
    JSON.stringify(r));
  await rpc(1, K.OP.FS_CLOSE, { fd: p0 });

  // ---- SIGKILL a process parked in accept: waiter canceled, fds released ----
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a'));
  const kpid = r.pid;
  r = await rpc(kpid, K.OP.SOCK_SOCKET, {});
  const klfd = r.fd;
  await rpc(kpid, K.OP.SOCK_BIND, { fd: klfd, path: '/tmp/kill.sock' });
  await rpc(kpid, K.OP.SOCK_LISTEN, { fd: klfd, backlog: 1 });
  const dk = submit(kpid, K.OP.SOCK_ACCEPT, { fd: klfd });
  await tick();
  check('victim parked in accept', dk.pending());
  kernel.kill(kpid, 9);
  check('SIGKILL zombifies the parked accepter', kernel.process(kpid).state === 'zombie');
  await rpc(1, K.OP.WAIT, { pid: kpid, options: 0 });
  r = await rpc(1, K.OP.SOCK_SOCKET, {});
  const probe = r.fd;
  r = await rpc(1, K.OP.SOCK_CONNECT, { fd: probe, path: '/tmp/kill.sock' });
  check('dead listener unregistered: connect refused', r.errno === 'ECONNREFUSED', JSON.stringify(r));
  await rpc(1, K.OP.FS_CLOSE, { fd: probe });
  kfs.unlink('/tmp/kill.sock');

  // ---- no OFD leaks: everything socket-ish is gone ----
  check('OFD table back to baseline', kernel._ofds.size === baselineOfds,
    kernel._ofds.size + ' vs ' + baselineOfds);
  check('rendezvous map empty', kernel._sockBinds.size === 0, String(kernel._sockBinds.size));

  console.log(failures === 0 ? '\nsocket semantics: PASS' : `\nsocket semantics: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
