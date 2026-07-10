#!/usr/bin/env node
// strace (todos/0046) protocol semantics without wasm: fake workers over a
// brokered kernel (test_kernel.js pattern), the test playing both the tracer
// (owns the pipe, reads decoded lines) and the tracee (issues RPCs). Covers:
// spec.trace validation (pipe write end only), request+result decode incl.
// RAW previews and errno, deferred-RPC trace-at-completion, EXIT/kill
// markers, EOF exactly at tracee teardown, -f style descendant inheritance
// with [pid N] prefixes, signal arrival markers, and the never-block drop
// policy (full pipe drops lines, exit marker reports the count).
//
// Run: node tests/kernel/test_strace.js
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

// ---- fake worker plumbing (same shape as test_kernel.js) ----
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

// Drain everything currently buffered in the trace pipe (init side). Init
// still holds its own write-end fd, so the pipe never EOFs here — peek the
// kernel-side buffer and only issue reads that can't park (a parked init
// would deadlock the single-threaded test).
async function drain(rfd) {
  let out = '';
  for (;;) {
    const o = kernel._ofds.get(kernel.process(1).fds.get(rfd));
    if (!o || o.pipe.buf.length === 0) return out;
    const r = await rpc(1, K.OP.FS_READ, { fd: rfd, count: 65000 });
    if (r.errno) throw new Error('trace read: ' + r.errno);
    if (!r.raw || r.raw.length === 0) return out;
    out += str(r.raw);
  }
}

// The traced-fd close actions every tracer passes (the child must not
// inherit the trace pipe).
const closeBoth = (rfd, wfd) => [{ op: 2, fd: rfd }, { op: 2, fd: wfd }];

(async () => {
  await kernel.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });

  // Seed a file for the tracee to read (init's RPCs are untraced).
  // BlockFS open flags: O_WRONLY=1, O_CREAT=0x40 (matches libc <fcntl.h>).
  let r = await rpc(1, K.OP.FS_OPEN, { path: '/f', flags: 0x41, mode: 0o644 });
  check('setup: file created', typeof r.fd === 'number', JSON.stringify(r));
  await wRpc(1, r.fd, Buffer.from('hi\n'));
  await rpc(1, K.OP.FS_CLOSE, { fd: r.fd });

  // ---- validation: trace must name a pipe WRITE end ----
  r = await rpc(1, K.OP.PIPE_CREATE, {});
  const rfd = r.rfd, wfd = r.wfd;
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', { trace: rfd }));
  check('trace on the READ end -> EBADF', r.errno === 'EBADF', JSON.stringify(r));
  r = await rpc(1, K.OP.FS_OPEN, { path: '/f', flags: 0 });
  const filefd = r.fd;
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', { trace: filefd }));
  check('trace on a file fd -> EBADF', r.errno === 'EBADF', JSON.stringify(r));
  await rpc(1, K.OP.FS_CLOSE, { fd: filefd });
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', { trace: 99 }));
  check('trace on an unused fd -> EBADF', r.errno === 'EBADF', JSON.stringify(r));
  // the failed spawns must not have consumed init's own pipe ends
  await wRpc(1, wfd, Buffer.from('x'));
  r = await rpc(1, K.OP.FS_READ, { fd: rfd, count: 8 });
  check('failed spawns leave the tracer pipe usable', r.raw && str(r.raw) === 'x',
    JSON.stringify(r));

  // ---- happy path: decode of open/read/write/close, errno, EXIT ----
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', {
    actions: closeBoth(rfd, wfd), trace: wfd,
  }));
  const c1 = r.pid;
  check('traced child spawned', typeof c1 === 'number' && c1 > 1, JSON.stringify(r));
  check('tracee pcb carries trace state', !!kernel.process(c1).trace);
  check('untraced init does not', !kernel.process(1).trace);

  r = await rpc(c1, K.OP.FS_OPEN, { path: '/f', flags: 0, mode: 0 });
  const cfd = r.fd;
  check('tracee open ok (fds 3/4 free again after CLOSE actions)', cfd === 3, JSON.stringify(r));
  r = await rpc(c1, K.OP.FS_READ, { fd: cfd, count: 100 });
  check('tracee read ok', r.raw && str(r.raw) === 'hi\n');
  r = await wRpc(c1, 1, Buffer.from('hi\n'));
  check('tracee write ok', r.n === 3, JSON.stringify(r));
  await rpc(c1, K.OP.FS_CLOSE, { fd: cfd });
  r = await rpc(c1, K.OP.FS_OPEN, { path: '/nope', flags: 0, mode: 0 });
  check('tracee ENOENT open', r.errno === 'ENOENT');
  submit(c1, K.OP.EXIT, { code: 5 });                 // no response by design
  await tick();
  r = await rpc(1, K.OP.WAIT, { pid: c1, options: 0 });
  check('tracee reaped with exit 5', r.status === (5 << 8), JSON.stringify(r));

  const t1 = await drain(rfd);
  check('trace: FS_OPEN decoded with args and fd result',
    t1.includes('FS_OPEN(path="/f", flags=0, mode=0) = 3'), JSON.stringify(t1));
  check('trace: FS_READ raw result previews the bytes',
    t1.includes('FS_READ(fd=3, count=100) = 3 "hi\\n"'), JSON.stringify(t1));
  check('trace: FS_WRITE raw request previews the bytes',
    t1.includes('FS_WRITE(fd=1, data="hi\\n", count=3) = 3'), JSON.stringify(t1));
  check('trace: errno decodes as -1 NAME',
    t1.includes('FS_OPEN(path="/nope", flags=0, mode=0) = -1 ENOENT'), JSON.stringify(t1));
  check('trace: EXIT line has no result', t1.includes('EXIT(code=5)'), JSON.stringify(t1));
  check('trace: exit marker', t1.includes('+++ exited with 5 +++'), JSON.stringify(t1));
  check('trace: no [pid] prefixes without follow', !t1.includes('[pid '), JSON.stringify(t1));

  // EOF semantics: the kernel released ITS write-end ref at tracee teardown;
  // init still holds wfd, so wOpen is true until init closes it. Close it
  // and confirm reads now hit EOF (nothing left buffered).
  await rpc(1, K.OP.FS_CLOSE, { fd: wfd });
  r = await rpc(1, K.OP.FS_READ, { fd: rfd, count: 10 });
  check('trace pipe fully drained + EOF after tracer closes its write end',
    r.raw && r.raw.length === 0, JSON.stringify(r));
  await rpc(1, K.OP.FS_CLOSE, { fd: rfd });

  // ---- deferred RPC: parked read traces at completion; kill mid-RPC ----
  r = await rpc(1, K.OP.PIPE_CREATE, {});
  const rfd2 = r.rfd, wfd2 = r.wfd;                    // trace pipe 2
  r = await rpc(1, K.OP.PIPE_CREATE, {});
  const drfd = r.rfd, dwfd = r.wfd;                    // data pipe the tracee blocks on
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', {
    actions: closeBoth(rfd2, wfd2), trace: wfd2,
  }));
  const c2 = r.pid;
  const parked = submit(c2, K.OP.FS_READ, { fd: drfd, count: 10 });
  await tick();
  check('tracee read parked (deferred RPC)', parked.pending());
  let t2 = await (async () => {
    // nothing lands until the RPC completes: buffered lines end at SPAWN-time
    const id = kernel.process(1).fds.get(rfd2);
    return str(Uint8Array.from(kernel._ofds.get(id).pipe.buf));
  })();
  check('deferred RPC has not traced yet', !t2.includes('FS_READ('), JSON.stringify(t2));
  await wRpc(1, dwfd, Buffer.from('go'));              // cross-process wake
  await parked.finish();
  const t2b = await drain(rfd2);
  check('deferred read traces at completion with its result',
    t2b.includes('FS_READ(fd=' + drfd + ', count=10) = 2 "go"'), JSON.stringify(t2b));

  // kill mid-RPC: park another read, SIGKILL the tracee.
  const parked2 = submit(c2, K.OP.FS_READ, { fd: drfd, count: 10 });
  await tick();
  check('tracee parked again', parked2.pending());
  kernel.kill(c2, 9, null);
  await rpc(1, K.OP.WAIT, { pid: c2, options: 0 });
  const t3 = await drain(rfd2);
  check('mid-RPC death traces as <unfinished>',
    t3.includes('FS_READ(fd=' + drfd + ', count=10) = <unfinished>'), JSON.stringify(t3));
  check('SIGKILL markers: signal arrival + killed-by',
    t3.includes('--- SIGKILL ---') && t3.includes('+++ killed by SIGKILL +++'),
    JSON.stringify(t3));
  await rpc(1, K.OP.FS_CLOSE, { fd: wfd2 });
  r = await rpc(1, K.OP.FS_READ, { fd: rfd2, count: 10 });
  check('trace pipe 2 EOF', r.raw && r.raw.length === 0);
  await rpc(1, K.OP.FS_CLOSE, { fd: rfd2 });

  // ---- follow (-f): descendants inherit, [pid N] prefixes ----
  r = await rpc(1, K.OP.PIPE_CREATE, {});
  const rfd3 = r.rfd, wfd3 = r.wfd;
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', {
    actions: closeBoth(rfd3, wfd3), trace: wfd3, flags: 4 | 2,
  }));
  const b = r.pid;
  r = await rpc(b, K.OP.SPAWN, spawnReq('/bin/a'));
  const g = r.pid;
  check('grandchild spawned by traced-with-follow parent', typeof g === 'number' && g > b);
  check('grandchild inherited the trace', !!kernel.process(g).trace);
  check('grandchild trace is follow too', kernel.process(g).trace.follow === true);
  await rpc(g, K.OP.FS_OPEN, { path: '/nope', flags: 0, mode: 0 });
  submit(g, K.OP.EXIT, { code: 0 });
  await tick();
  await rpc(b, K.OP.WAIT, { pid: g, options: 0 });
  submit(b, K.OP.EXIT, { code: 0 });
  await tick();
  await rpc(1, K.OP.WAIT, { pid: b, options: 0 });
  const t4 = await drain(rfd3);
  check('follow: parent SPAWN line pid-prefixed',
    t4.includes('[pid ' + b + '] SPAWN('), JSON.stringify(t4));
  check('follow: grandchild lines pid-prefixed',
    t4.includes('[pid ' + g + '] FS_OPEN(path="/nope"'), JSON.stringify(t4));
  check('follow: both exits marked',
    t4.includes('[pid ' + g + '] +++ exited with 0 +++') &&
    t4.includes('[pid ' + b + '] +++ exited with 0 +++'), JSON.stringify(t4));
  await rpc(1, K.OP.FS_CLOSE, { fd: wfd3 });
  await rpc(1, K.OP.FS_CLOSE, { fd: rfd3 });

  // ---- non-follow child of a traced parent is NOT traced ----
  r = await rpc(1, K.OP.PIPE_CREATE, {});
  const rfd4 = r.rfd, wfd4 = r.wfd;
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', {
    actions: closeBoth(rfd4, wfd4), trace: wfd4,
  }));
  const nf = r.pid;
  r = await rpc(nf, K.OP.SPAWN, spawnReq('/bin/a'));
  check('non-follow: child of traced parent untraced', !kernel.process(r.pid).trace);
  submit(r.pid, K.OP.EXIT, { code: 0 });
  submit(nf, K.OP.EXIT, { code: 0 });
  await tick();
  await rpc(1, K.OP.WAIT, { pid: nf, options: 0 });

  // ---- drop policy: full pipe drops lines, exit marker reports it ----
  r = await rpc(1, K.OP.PIPE_CREATE, {});
  const rfd5 = r.rfd, wfd5 = r.wfd;
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', {
    actions: closeBoth(rfd5, wfd5), trace: wfd5,
  }));
  const dp = r.pid;
  kernel.process(dp).trace.pipe.cap = 120;   // force the overflow fast
  for (let i = 0; i < 20; i++) {
    await rpc(dp, K.OP.FS_OPEN, { path: '/nope', flags: 0, mode: 0 });
  }
  submit(dp, K.OP.EXIT, { code: 0 });
  await tick();
  await rpc(1, K.OP.WAIT, { pid: dp, options: 0 });
  kernel._ofds.get(kernel.process(1).fds.get(rfd5)).pipe.cap = K.PIPE_CAP || 65536;
  const t5 = await drain(rfd5);
  check('drop policy: some lines dropped, count reported',
    /\+\+\+ \d+ trace lines dropped \(pipe full\) \+\+\+/.test(t5), JSON.stringify(t5));
  check('drop policy: exit marker still lands (forced past the cap)',
    t5.includes('+++ exited with 0 +++'), JSON.stringify(t5));
  await rpc(1, K.OP.FS_CLOSE, { fd: wfd5 });
  await rpc(1, K.OP.FS_CLOSE, { fd: rfd5 });

  console.log(failures ? `\n${failures} FAILURE(S)` : '\nall ok');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
