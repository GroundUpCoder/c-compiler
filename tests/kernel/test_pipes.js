#!/usr/bin/env node
// Phase 4 pipe semantics (todos/0003) without wasm: fake workers over a
// BROKERED kernel (opts.fs), the test playing the process side of the
// kernel-page protocol — pipes are OFDs, so creation/read/write/close all
// ride the same fd RPCs as files (test_kernel.js pattern; see there for the
// plumbing rationale). Protocol rule the test respects: a process with a
// deferred RPC in flight is parked and cannot issue another one — triggers
// come from a DIFFERENT process or the embedder-facing kernel.kill().
//
// Run: node tests/kernel/test_pipes.js
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
// FS_WRITE raw request: [u32 fd][bytes]
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

(async () => {
  await kernel.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });

  // ---- create / immediate write+read / wrong-end EBADF / FIFO fstat ----
  let r = await rpc(1, K.OP.PIPE_CREATE, {});
  check('pipe created past stdio fds', r.rfd === 3 && r.wfd === 4, JSON.stringify(r));
  const rfd = r.rfd, wfd = r.wfd;
  r = await wRpc(1, wfd, Buffer.from('hello'));
  check('write to pipe', r.n === 5, JSON.stringify(r));
  r = await rpc(1, K.OP.FS_READ, { fd: rfd, count: 100 });
  check('read gets the bytes', r.raw && str(r.raw) === 'hello', JSON.stringify(r));
  r = await rpc(1, K.OP.FS_READ, { fd: wfd, count: 10 });
  check('read on write end -> EBADF', r.errno === 'EBADF');
  r = await wRpc(1, rfd, Buffer.from('x'));
  check('write on read end -> EBADF', r.errno === 'EBADF');
  r = await rpc(1, K.OP.FS_FSTAT, { fd: rfd });
  check('fstat says FIFO', r.st && (r.st.mode & 0xF000) === 0x1000, JSON.stringify(r));

  // ---- deferred read woken by a cross-process write; EINTR; EOF ----
  // The reader child closes its inherited write end via a CLOSE fd_action,
  // so init's write end is the only one — init's close alone means EOF.
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', { actions: [{ op: 2, fd: wfd }] }));
  const rpid = r.pid;
  check('reader child spawned', rpid === 2, JSON.stringify(r));
  const dr = submit(rpid, K.OP.FS_READ, { fd: rfd, count: 100 });
  await tick();
  check('empty-pipe read defers', dr.pending());
  await wRpc(1, wfd, Buffer.from('wake'));
  r = await dr.finish();
  check('parked read woken by cross-process write', r.raw && str(r.raw) === 'wake', JSON.stringify(r));

  const di = submit(rpid, K.OP.FS_READ, { fd: rfd, count: 100 });
  await tick();
  check('read parked again', di.pending());
  workers.get(rpid).msg({ type: 'krpc-intr' });
  r = await di.finish();
  check('krpc-intr answers EINTR on a pipe read', r.errno === 'EINTR', JSON.stringify(r));

  const de = submit(rpid, K.OP.FS_READ, { fd: rfd, count: 100 });
  await tick();
  check('read parked for the EOF test', de.pending());
  await rpc(1, K.OP.FS_CLOSE, { fd: wfd });          // the LAST write end anywhere
  r = await de.finish();
  check('last write end closed -> EOF (empty read)', r.raw && r.raw.length === 0, JSON.stringify(r));
  workers.get(rpid).msg({ type: 'exited', code: 0 });
  await rpc(1, K.OP.WAIT, { pid: rpid, options: 0 });

  // ---- EPIPE + SIGPIPE at DFL: write after every read end is gone ----
  r = await rpc(1, K.OP.PIPE_CREATE, {});
  const rfd2 = r.rfd, wfd2 = r.wfd;
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', { actions: [{ op: 2, fd: rfd2 }] }));
  const wpid = r.pid;                                // holds only the write end
  await rpc(1, K.OP.FS_CLOSE, { fd: rfd2 });         // last read end gone
  r = await wRpc(wpid, wfd2, Buffer.from('doomed'));
  check('write to reader-less pipe -> EPIPE', r.errno === 'EPIPE', JSON.stringify(r));
  check('SIGPIPE at DFL terminates the writer', kernel.process(wpid).state === 'zombie');
  r = await rpc(1, K.OP.WAIT, { pid: wpid, options: 0 });
  check('writer waits as WTERMSIG SIGPIPE', r.status === 13, JSON.stringify(r));
  await rpc(1, K.OP.FS_CLOSE, { fd: wfd2 });

  // ---- EPIPE with a handler: bit posted, process survives ----
  r = await rpc(1, K.OP.PIPE_CREATE, {});
  const rfd3 = r.rfd, wfd3 = r.wfd;
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', { actions: [{ op: 2, fd: rfd3 }] }));
  const hpid = r.pid;
  await rpc(hpid, K.OP.SIGDISP, { sig: 13, kind: 2 /* HANDLER */ });
  await rpc(1, K.OP.FS_CLOSE, { fd: rfd3 });
  r = await wRpc(hpid, wfd3, Buffer.from('survives'));
  check('caught SIGPIPE: write returns EPIPE', r.errno === 'EPIPE', JSON.stringify(r));
  check('caught SIGPIPE: bit posted, still running',
    kernel.process(hpid).state === 'running' &&
    (Atomics.load(page(hpid).i32, K.KP_SIGPEND) & (1 << 12)) !== 0);
  Atomics.store(page(hpid).i32, K.KP_SIGPEND, 0);
  workers.get(hpid).msg({ type: 'exited', code: 0 });
  await rpc(1, K.OP.WAIT, { pid: hpid, options: 0 });
  await rpc(1, K.OP.FS_CLOSE, { fd: wfd3 });

  // ---- full-pipe blocking write, partial writes, PIPE_ATOMIC ----
  r = await rpc(1, K.OP.PIPE_CREATE, {});
  const rfd4 = r.rfd, wfd4 = r.wfd;
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a'));  // inherits both pipe ends
  const bpid = r.pid;
  r = await wRpc(1, wfd4, Buffer.alloc(60000, 65));
  check('big write lands whole', r.n === 60000, JSON.stringify(r));
  r = await wRpc(1, wfd4, Buffer.alloc(6000, 66));
  check('write to nearly-full pipe is partial', r.n === 5536, JSON.stringify(r));
  const dw = wDefer(bpid, wfd4, Buffer.from('block'));  // full + small: defers whole
  await tick();
  check('write to full pipe defers', dw.pending());
  r = await rpc(1, K.OP.FS_READ, { fd: rfd4, count: 50000 });
  check('drain read', r.raw && r.raw.length === 50000 && r.raw[0] === 65, r.raw && r.raw.length);
  r = await dw.finish();
  check('parked write completes after drain', r.n === 5, JSON.stringify(r));
  r = await rpc(1, K.OP.FS_READ, { fd: rfd4, count: 65536 });
  check('tail preserves order', r.raw && r.raw.length === 15536 + 5 &&
    str(r.raw.subarray(r.raw.length - 5)) === 'block', r.raw && r.raw.length);

  // ---- select: pipe readiness + deferred select woken by a pipe write ----
  r = await rpc(1, K.OP.FS_SELECT, { r: [rfd4], w: [wfd4], timeoutMs: 0 });
  check('select: drained pipe not read-ready, write-ready',
    r.count === 1 && r.r.length === 0 && r.w.length === 1, JSON.stringify(r));
  const ds = submit(1, K.OP.FS_SELECT, { r: [rfd4], w: [], timeoutMs: null });
  await tick();
  check('select on empty pipe defers', ds.pending());
  await wRpc(bpid, wfd4, Buffer.from('sel'));
  r = await ds.finish();
  check('deferred select woken by pipe write', r.count === 1 && r.r[0] === rfd4, JSON.stringify(r));
  await rpc(1, K.OP.FS_READ, { fd: rfd4, count: 100 });
  workers.get(bpid).msg({ type: 'exited', code: 0 });
  await rpc(1, K.OP.WAIT, { pid: bpid, options: 0 });

  // ---- #644: zero-length writes — the Linux "null write succeeds" rule ----
  // POSIX leaves nbyte==0 unspecified on pipes; gucOS answers like Linux
  // (fs/pipe.c): n=0 IMMEDIATELY. On a FULL pipe the old path deferred the
  // writer behind free===0; with every read end gone it EPIPE'd + SIGPIPE'd.
  r = await rpc(1, K.OP.PIPE_CREATE, {});
  const rfdZ = r.rfd, wfdZ = r.wfd;
  // Fill to cap in two writes: one payload can't exceed KP_FS_CHUNK (60000),
  // and the second write partial-lands the remaining 5536 (cap 65536).
  r = await wRpc(1, wfdZ, Buffer.alloc(60000, 67));
  const zfill = r.n;
  r = await wRpc(1, wfdZ, Buffer.alloc(6000, 67));
  check('pipe filled to cap', zfill === 60000 && r.n === 5536, JSON.stringify(r));
  const dz = wDefer(1, wfdZ, Buffer.alloc(0));
  await tick();
  check('zero write on a FULL pipe does not defer', !dz.pending());
  r = await dz.finish();
  check('zero write on a full pipe returns 0', r.n === 0, JSON.stringify(r));
  r = await rpc(1, K.OP.FS_READ, { fd: rfdZ, count: 60000 });
  const zdrain = r.raw ? r.raw.length : -1;
  r = await rpc(1, K.OP.FS_READ, { fd: rfdZ, count: 60000 });
  check('fill intact after the null write', zdrain === 60000 &&
    r.raw && r.raw.length === 5536 && r.raw[0] === 67, zdrain + '+' + (r.raw && r.raw.length));
  // Reader-less: a child holding the write end (the EPIPE-section shape).
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', { actions: [{ op: 2, fd: rfdZ }] }));
  const zpid = r.pid;
  await rpc(1, K.OP.FS_CLOSE, { fd: rfdZ });           // last read end gone
  r = await wRpc(zpid, wfdZ, Buffer.alloc(0));
  check('zero write to a reader-less pipe returns 0, not EPIPE', r.n === 0, JSON.stringify(r));
  check('no SIGPIPE for the null write: writer still running, no bit posted',
    kernel.process(zpid).state === 'running' &&
    (Atomics.load(page(zpid).i32, K.KP_SIGPEND) & (1 << 12)) === 0);
  r = await wRpc(zpid, wfdZ, Buffer.from('doomed'));   // control: nonzero still dies
  check('nonzero write still EPIPE + SIGPIPE at DFL', r.errno === 'EPIPE' &&
    kernel.process(zpid).state === 'zombie', JSON.stringify(r));
  await rpc(1, K.OP.WAIT, { pid: zpid, options: 0 });
  await rpc(1, K.OP.FS_CLOSE, { fd: wfdZ });

  // ---- fd_actions wire a pipe across spawn (the shell-pipeline shape) ----
  r = await rpc(1, K.OP.PIPE_CREATE, {});
  const rfd5 = r.rfd, wfd5 = r.wfd;
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', {
    actions: [{ op: 0, arg: wfd5, fd: 1 }, { op: 2, fd: rfd5 }, { op: 2, fd: wfd5 }],
  }));
  const cpid = r.pid;
  check('pipeline child spawned', cpid > 0, JSON.stringify(r));
  r = await wRpc(cpid, 1, Buffer.from('via stdout'));  // child fd 1 IS the pipe
  check('child stdout write goes to the pipe', r.n === 10, JSON.stringify(r));
  workers.get(cpid).msg({ type: 'exited', code: 0 });
  await rpc(1, K.OP.WAIT, { pid: cpid, options: 0 });
  r = await rpc(1, K.OP.FS_READ, { fd: rfd5, count: 100 });
  check('parent reads the child output', r.raw && str(r.raw) === 'via stdout', JSON.stringify(r));
  await rpc(1, K.OP.FS_CLOSE, { fd: wfd5 });
  r = await rpc(1, K.OP.FS_READ, { fd: rfd5, count: 100 });
  check('EOF after child exit + own close', r.raw && r.raw.length === 0, JSON.stringify(r));
  await rpc(1, K.OP.FS_CLOSE, { fd: rfd5 });

  // ---- SIGKILL while parked on a pipe: waiter canceled, fds released ----
  r = await rpc(1, K.OP.PIPE_CREATE, {});
  const rfd6 = r.rfd, wfd6 = r.wfd;
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a'));
  const kpid = r.pid;
  const dk = submit(kpid, K.OP.FS_READ, { fd: rfd6, count: 10 });
  await tick();
  check('victim parked on pipe read', dk.pending());
  kernel.kill(kpid, 9);
  check('SIGKILL zombifies the parked reader', kernel.process(kpid).state === 'zombie');
  await rpc(1, K.OP.WAIT, { pid: kpid, options: 0 });
  r = await wRpc(1, wfd6, Buffer.from('nobody'));
  check('write after victim death still lands (init holds the read end)', r.n === 6, JSON.stringify(r));

  // ---- job control (#647): a STOPPED pipe reader is parked, not a consumer ----
  // The tty serve loop skips STATE_STOPPED waiters (a Ctrl-Z'd cat must not
  // steal the shell's next typed line); _pipeNotify applies the same rule,
  // and _contProcess re-notifies the parked stream so data (or EOF) that
  // arrived during the stop is served at resume — never stranded.
  r = await rpc(1, K.OP.PIPE_CREATE, {});
  const rfd7 = r.rfd, wfd7 = r.wfd;
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', { actions: [{ op: 2, fd: wfd7 }] }));
  const spid = r.pid;
  const dstop = submit(spid, K.OP.FS_READ, { fd: rfd7, count: 100 });
  await tick();
  check('reader parked before stop', dstop.pending());
  kernel.kill(spid, K.SIG.STOP);
  await tick();
  check('SIGSTOP stops the parked reader', kernel.process(spid).state === 'stopped');
  r = await wRpc(1, wfd7, Buffer.from('held'));
  check('write succeeds while the reader is stopped', r.n === 4, JSON.stringify(r));
  await tick();
  check('stopped reader consumes nothing: read still parked', dstop.pending());
  kernel.kill(spid, K.SIG.CONT);
  await tick();
  check('SIGCONT serves the parked read — no strand', !dstop.pending());
  r = await dstop.finish();
  check('resumed reader gets the bytes written during the stop',
    r.raw && str(r.raw) === 'held', JSON.stringify(r));

  // Steal shape: two readers share the read end; the stopped one parked
  // FIRST must not shadow the running one behind it in the FIFO.
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', { actions: [{ op: 2, fd: wfd7 }] }));
  const spid2 = r.pid;
  const da = submit(spid, K.OP.FS_READ, { fd: rfd7, count: 100 });
  await tick();
  kernel.kill(spid, K.SIG.STOP);
  await tick();
  const db = submit(spid2, K.OP.FS_READ, { fd: rfd7, count: 100 });
  await tick();
  r = await wRpc(1, wfd7, Buffer.from('mine'));
  await tick();
  check('running reader is served past the stopped one ahead of it',
    !db.pending() && da.pending());
  r = await db.finish();
  check('...and gets the written bytes', r.raw && str(r.raw) === 'mine', JSON.stringify(r));
  kernel.kill(spid, K.SIG.CONT);
  await tick();
  check('resumed reader stays parked on the now-empty pipe', da.pending());
  r = await wRpc(1, wfd7, Buffer.from('next'));
  r = await da.finish();
  check('next write serves the resumed reader', r.raw && str(r.raw) === 'next', JSON.stringify(r));

  // EOF landing during a stop is served at resume (the !wOpen leg of the
  // cont-side re-notify).
  r = await rpc(1, K.OP.PIPE_CREATE, {});
  const rfd8 = r.rfd, wfd8 = r.wfd;
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', { actions: [{ op: 2, fd: wfd8 }] }));
  const epid = r.pid;
  const dceof = submit(epid, K.OP.FS_READ, { fd: rfd8, count: 10 });
  await tick();
  kernel.kill(epid, K.SIG.STOP);
  await tick();
  await rpc(1, K.OP.FS_CLOSE, { fd: wfd8 });           // last write end gone
  await tick();
  check('EOF while stopped: read still parked', dceof.pending());
  kernel.kill(epid, K.SIG.CONT);
  await tick();
  r = await dceof.finish();
  check('resume serves the EOF', r.raw && r.raw.length === 0, JSON.stringify(r));

  console.log(failures === 0 ? '\npipe semantics: PASS' : `\npipe semantics: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
