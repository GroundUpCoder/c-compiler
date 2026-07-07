#!/usr/bin/env node
// Pty semantics (todos/0020) without wasm: fake workers over a BROKERED
// kernel, the test playing the process side of the kernel-page protocol
// (test_pipes.js pattern). The pty slave is a full Tty — the same line
// discipline test_tty.js covers — so this file focuses on what's NEW:
// the pair rendezvous, master<->slave byte flow (echo, ONLCR), fd-aware
// termios resolution (pty vs system tty), TIOCSWINSZ -> SIGWINCH, spawn
// attachment (ttySab + fgPgid claim), select readiness on both ends,
// whole-write blocking, and the close lifecycle (SIGHUP/EOF/EIO).
//
// Protocol rule the test respects: a process with a deferred RPC in
// flight is parked and cannot issue another one — triggers come from a
// DIFFERENT process or the embedder-facing kernel API.
//
// Run: node tests/kernel/test_pty.js
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

// ---- fake worker plumbing (test_kernel.js shape) ----
const workers = new Map();
function createWorker(procSpec) {
  const h = {
    procSpec, msg: null, terminated: false,
    postMessage() {}, onMessage(fn) { h.msg = fn; }, onExit(fn) { h.exitCb = fn; },
    terminate() { h.terminated = true; },
  };
  workers.set(procSpec.pid, h);
  return h;
}

const images = new Map([
  ['/bin/init', new Uint8Array([1])],
  ['/bin/term', new Uint8Array([2])],
  ['/bin/sh', new Uint8Array([3])],
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
const sysTty = kernel.createTty({ cols: 80, rows: 24, output: () => {} });

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
const str = (b) => Buffer.from(b).toString('latin1');
const pend = (pid) => Atomics.load(page(pid).i32, K.KP_SIGPEND);
const clearPend = (pid) => Atomics.store(page(pid).i32, K.KP_SIGPEND, 0);
const bit = (sig) => 1 << (sig - 1);
// Drain everything readable from an fd (master side) into a string.
async function drain(pid, fd) {
  let out = '';
  for (;;) {
    const s = await rpc(pid, K.OP.FS_SELECT, { r: [fd], w: [], timeoutMs: 0 });
    if (!s.r || s.r.indexOf(fd) < 0) return out;
    const r = await rpc(pid, K.OP.FS_READ, { fd, count: 4096 });
    if (!r.raw || r.raw.length === 0) return out;
    out += str(r.raw);
  }
}

(async () => {
  await kernel.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });

  // ---- pair creation ----
  let r = await rpc(1, K.OP.PTY_CREATE, {});
  check('pty pair created past stdio fds', r.mfd === 3 && r.sfd === 4, JSON.stringify(r));
  const mfd = r.mfd, sfd = r.sfd;
  r = await rpc(1, K.OP.FS_ISATTY, { fd: sfd });
  check('slave isatty', r.tty === 1);
  r = await rpc(1, K.OP.FS_ISATTY, { fd: mfd });
  check('master isatty', r.tty === 1);

  // ---- fd-aware termios: the fd names the pty, not the caller's tty ----
  r = await rpc(1, K.OP.TCGETATTR, { fd: sfd });
  check('slave starts canonical', (r.lflag & 0x100) !== 0 && (r.lflag & 0x8) !== 0, JSON.stringify(r));
  r = await rpc(1, K.OP.TCGETATTR, { fd: mfd });
  check('master resolves the pair termios', (r.lflag & 0x100) !== 0, JSON.stringify(r));
  r = await rpc(1, K.OP.TCGETATTR, {});
  check('fd-less getattr falls back to the attached tty', (r.lflag & 0x100) !== 0);

  // ---- spawn the "shell" on the slave: dup2 to 0/1/2, close the pair fds ----
  r = await rpc(1, K.OP.SPAWN, {
    path: '/bin/sh', argv: ['sh'], envp: [], cwd: '/', flags: 1, pgid: 0,
    actions: [
      { op: 0, arg: sfd, fd: 0 }, { op: 0, arg: sfd, fd: 1 }, { op: 0, arg: sfd, fd: 2 },
      { op: 2, fd: mfd }, { op: 2, fd: sfd },
    ],
  });
  const sh = r.pid;
  check('shell spawned on the slave', sh === 2, JSON.stringify(r));
  const ptyTty = kernel.process(sh).tty;
  check('spawn attached the pty as the child tty', ptyTty !== sysTty && ptyTty !== null);
  check('child worker got the pty winsize SAB', workers.get(sh).procSpec.ttySab === ptyTty.sab);
  check('first attach claims the foreground', ptyTty.fgPgid === sh, String(ptyTty.fgPgid));
  check('system tty foreground untouched', sysTty.fgPgid === 1, String(sysTty.fgPgid));
  // init drops its slave copy, like a real terminal app.
  r = await rpc(1, K.OP.FS_CLOSE, { fd: sfd });
  check('terminal app closes its slave copy', !r.errno);

  // ---- master write -> line discipline -> slave read; echo to master ----
  r = await wRpc(1, mfd, Buffer.from('hi\r'));
  check('master write accepted in full', r.n === 3, JSON.stringify(r));
  r = await rpc(sh, K.OP.FS_READ, { fd: 0, count: 100 });
  check('slave read gets the cooked line (ICRNL)', r.raw && str(r.raw) === 'hi\n', JSON.stringify(r));
  check('echo lands on the master (ONLCR)', await drain(1, mfd) === 'hi\r\n');

  // ---- deferred slave read served by a master write ----
  const dsr = submit(sh, K.OP.FS_READ, { fd: 0, count: 100 });
  await tick();
  check('empty slave read defers', dsr.pending());
  await wRpc(1, mfd, Buffer.from('ok\r'));
  r = await dsr.finish();
  check('master write wakes the parked slave read', r.raw && str(r.raw) === 'ok\n', JSON.stringify(r));
  await drain(1, mfd);   // discard the echo

  // ---- slave write -> OPOST/ONLCR -> master read (and a deferred one) ----
  r = await wRpc(sh, 1, Buffer.from('out\n'));
  check('slave write reports pre-OPOST count', r.n === 4, JSON.stringify(r));
  check('master reads it ONLCR-expanded', await drain(1, mfd) === 'out\r\n');
  const dmr = submit(1, K.OP.FS_READ, { fd: mfd, count: 100 });
  await tick();
  check('empty master read defers', dmr.pending());
  await wRpc(sh, 2, Buffer.from('err\n'));
  r = await dmr.finish();
  check('slave write wakes the parked master read', r.raw && str(r.raw) === 'err\r\n', JSON.stringify(r));

  // ---- control chars route to the PTY's fg pgroup, not the system one ----
  await rpc(sh, K.OP.SIGDISP, { sig: 2, kind: 2 });   // SIGINT handler
  await wRpc(1, mfd, Buffer.from('\x03'));
  check('^C through the master posts SIGINT to the pty fg', (pend(sh) & bit(2)) !== 0);
  check('^C spares the system tty fg', (pend(1) & bit(2)) === 0);
  clearPend(sh);
  check('^C echoes the caret form to the master', await drain(1, mfd) === '^C\r\n');

  // ---- TIOCSWINSZ on the master: winsize words + SIGWINCH ----
  await rpc(sh, K.OP.SIGDISP, { sig: 28, kind: 2 }); // SIGWINCH handler
  r = await rpc(1, K.OP.TIOCSWINSZ, { fd: mfd, rows: 50, cols: 132 });
  check('TIOCSWINSZ accepted', !r.errno, JSON.stringify(r));
  const ptyI32 = new Int32Array(ptyTty.sab, 0, 8);
  check('winsize words updated on the pty SAB',
    Atomics.load(ptyI32, 5) === 132 && Atomics.load(ptyI32, 6) === 50);
  check('SIGWINCH posted to the pty fg pgroup', (pend(sh) & bit(28)) !== 0);
  check('SIGWINCH spares the system fg', (pend(1) & bit(28)) === 0);
  clearPend(sh);
  r = await rpc(1, K.OP.TIOCSWINSZ, { fd: mfd, rows: 50, cols: 132 });
  check('no-op TIOCSWINSZ posts nothing', (pend(sh) & bit(28)) === 0);

  // ---- fd-aware TCSETATTR: raw pty, canonical system tty ----
  r = await rpc(sh, K.OP.TCGETATTR, { fd: 0 });
  await rpc(sh, K.OP.TCSETATTR, { fd: 0, actions: 0, iflag: 0, oflag: r.oflag, cflag: r.cflag, lflag: 0, cc: r.cc });
  r = await rpc(sh, K.OP.TCGETATTR, { fd: 0 });
  check('pty now raw', (r.lflag & 0x100) === 0, JSON.stringify(r.lflag));
  r = await rpc(1, K.OP.TCGETATTR, {});
  check('system tty still canonical', (r.lflag & 0x100) !== 0, JSON.stringify(r.lflag));
  await wRpc(1, mfd, Buffer.from('x\x03y\r'));
  r = await rpc(sh, K.OP.FS_READ, { fd: 0, count: 100 });
  check('raw pty passes everything through', r.raw && str(r.raw) === 'x\x03y\r', JSON.stringify(r));
  check('raw pty does not echo', await drain(1, mfd) === '');
  check('raw ^C posts nothing', (pend(sh) & bit(2)) === 0);
  // OPOST still on: slave writes stay ONLCR-processed even in "raw" input.
  await wRpc(sh, 1, Buffer.from('a\n'));
  check('OPOST independent of input mode', await drain(1, mfd) === 'a\r\n');
  // Drop OPOST too: bytes cross verbatim (vi's cursor addressing needs this).
  r = await rpc(sh, K.OP.TCGETATTR, { fd: 0 });
  await rpc(sh, K.OP.TCSETATTR, { fd: 0, actions: 0, iflag: 0, oflag: 0, cflag: r.cflag, lflag: 0, cc: r.cc });
  await wRpc(sh, 1, Buffer.from('b\n'));
  check('-opost writes cross verbatim', await drain(1, mfd) === 'b\n');
  r = await rpc(sh, K.OP.TCGETATTR, { fd: 0 });
  await rpc(sh, K.OP.TCSETATTR, { fd: 0, actions: 0, iflag: 0x100, oflag: 0x3, cflag: r.cflag, lflag: 0x18E, cc: r.cc });

  // ---- tcgetpgrp/tcsetpgrp resolve per-fd ----
  r = await rpc(sh, K.OP.TCGETPGRP, { fd: 0 });
  check('tcgetpgrp on the slave reads the pty fg', r.pgid === sh, JSON.stringify(r));
  r = await rpc(1, K.OP.TCGETPGRP, {});
  check('fd-less tcgetpgrp reads the system fg', r.pgid === 1, JSON.stringify(r));

  // ---- select readiness on both ends ----
  r = await rpc(sh, K.OP.FS_SELECT, { r: [0], w: [], timeoutMs: 0 });
  check('slave not read-ready when idle', r.count === 0, JSON.stringify(r));
  await wRpc(1, mfd, Buffer.from('z\r'));
  r = await rpc(sh, K.OP.FS_SELECT, { r: [0], w: [], timeoutMs: 0 });
  check('slave read-ready after master write', r.r && r.r.indexOf(0) >= 0, JSON.stringify(r));
  r = await rpc(sh, K.OP.FS_READ, { fd: 0, count: 100 });
  check('…and the line arrives', r.raw && str(r.raw) === 'z\n');
  await drain(1, mfd);
  r = await rpc(1, K.OP.FS_SELECT, { r: [mfd], w: [mfd], timeoutMs: 0 });
  check('idle master: write-ready only', r.r.length === 0 && r.w.indexOf(mfd) >= 0, JSON.stringify(r));
  await wRpc(sh, 1, Buffer.from('ping\n'));
  r = await rpc(1, K.OP.FS_SELECT, { r: [mfd], w: [], timeoutMs: 0 });
  check('master read-ready after slave write', r.r.indexOf(mfd) >= 0, JSON.stringify(r));
  await drain(1, mfd);

  // ---- background pgroup reading the pty -> SIGTTIN (stop class) ----
  r = await rpc(sh, K.OP.SPAWN, { path: '/bin/sh', argv: ['bg'], envp: [], cwd: '/', flags: 1, pgid: 0, actions: [] });
  const bg = r.pid;
  r = await rpc(bg, K.OP.FS_READ, { fd: 0, count: 10 });
  check('background pty read -> EINTR', r.errno === 'EINTR', JSON.stringify(r));
  check('…and the background pgroup stopped (SIGTTIN default)',
    kernel.process(bg).state === 'stopped');
  kernel.kill(bg, 9);

  // ---- whole-write blocking: a full master direction parks the slave ----
  // 256K cap; 60000-byte writes (the RemoteFS chunk size) with no NL so the
  // counts stay exact. The 5th write can't fit whole -> defers; master
  // drains -> it completes reporting the ORIGINAL byte count.
  const chunk = Buffer.alloc(60000, 0x61);
  for (let i = 0; i < 4; i++) {
    r = await wRpc(sh, 1, chunk);
    check('bulk write ' + i + ' fits (n=60000)', r.n === 60000, JSON.stringify(r));
  }
  const dw = submit(sh, K.OP.FS_WRITE, writeReq(1, chunk), true);
  await tick();
  check('write past the cap defers whole', dw.pending());
  let got = 0;
  while (got < 240000) {
    r = await rpc(1, K.OP.FS_READ, { fd: mfd, count: 60000 });
    got += r.raw.length;
  }
  r = await dw.finish();
  check('parked whole-write completes after drain', r.n === 60000, JSON.stringify(r));
  check('…delivering exactly its bytes', (await drain(1, mfd)).length === 60000);

  // ---- master close: SIGHUP to the pty fg, slave EOF, slave write EIO ----
  await rpc(sh, K.OP.SIGDISP, { sig: 1, kind: 2 });   // survive SIGHUP for the checks
  r = await rpc(1, K.OP.FS_CLOSE, { fd: mfd });
  check('master closed', !r.errno);
  check('SIGHUP posted to the pty fg pgroup', (pend(sh) & bit(1)) !== 0);
  clearPend(sh);
  r = await rpc(sh, K.OP.FS_READ, { fd: 0, count: 10 });
  check('slave read after master close -> EOF', r.raw && r.raw.length === 0, JSON.stringify(r));
  r = await wRpc(sh, 1, Buffer.from('dead\n'));
  check('slave write after master close -> EIO', r.errno === 'EIO', JSON.stringify(r));

  // ---- slave close (all refs): master reads EOF ----
  r = await rpc(1, K.OP.PTY_CREATE, {});
  const m2 = r.mfd, s2 = r.sfd;
  await wRpc(1, m2, Buffer.from('q'));               // canonical: stays in the edit buffer
  r = await rpc(1, K.OP.FS_CLOSE, { fd: s2 });
  check('lone slave ref closed', !r.errno);
  r = await rpc(1, K.OP.FS_READ, { fd: m2, count: 100 });
  check('master drains the echo before EOF', r.raw && str(r.raw) === 'q', JSON.stringify(r));
  r = await rpc(1, K.OP.FS_READ, { fd: m2, count: 100 });
  check('then master read -> EOF', r.raw && r.raw.length === 0, JSON.stringify(r));
  r = await rpc(1, K.OP.FS_SELECT, { r: [m2], w: [], timeoutMs: 0 });
  check('slave-gone master is read-ready (EOF)', r.r.indexOf(m2) >= 0, JSON.stringify(r));
  await rpc(1, K.OP.FS_CLOSE, { fd: m2 });

  // ---- SIGKILL on the shell releases slave refs (kernel-owned fds) ----
  r = await rpc(1, K.OP.PTY_CREATE, {});
  const m3 = r.mfd, s3 = r.sfd;
  r = await rpc(1, K.OP.SPAWN, {
    path: '/bin/sh', argv: ['sh'], envp: [], cwd: '/', flags: 1, pgid: 0,
    actions: [{ op: 0, arg: s3, fd: 0 }, { op: 2, fd: m3 }, { op: 2, fd: s3 }],
  });
  const sh3 = r.pid;
  await rpc(1, K.OP.FS_CLOSE, { fd: s3 });
  kernel.kill(sh3, 9);
  r = await rpc(1, K.OP.FS_READ, { fd: m3, count: 100 });
  check('SIGKILLed slave holder -> master EOF', r.raw && r.raw.length === 0, JSON.stringify(r));

  console.log(failures === 0 ? '\npty semantics: PASS' : `\npty semantics: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
  console.log('  FAIL ' + (e && e.stack || e));
  console.log('\npty semantics: FAILED');
  process.exit(1);
});
