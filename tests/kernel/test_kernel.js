#!/usr/bin/env node
// Kernel semantics without wasm: a fake createWorker captures each process's
// message handlers, and the TEST plays the process side of the kernel-page
// protocol — writing real RPC requests into the SAB and delivering
// {type:'krpc'}/{type:'exited'}/... messages by hand. This exercises the real
// transport (page layout, JSON codec, doorbell/RPC state machine) and the
// full process-table semantics deterministically, with no threads.
//
// Run: node tests/kernel/test_kernel.js
'use strict';
const path = require('path');
const K = require(path.resolve(__dirname, '../../kernel.js'));

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}
const tick = () => new Promise((r) => setImmediate(r));

// ---- fake worker plumbing ----
const workers = new Map(); // pid -> handle (with .procSpec, .msg, .exitCb, .terminated)
function createWorker(procSpec) {
  const h = {
    procSpec,
    msg: null,
    exitCb: null,
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
  ['/bin/b', new Uint8Array([3])],
]);

let halted = null;
let output = [];
const kernel = new K.Kernel({
  createWorker,
  loadImage: (p) => images.get(p) || null,
  compile: (argv, cwd) => ({ exitCode: 3, stdout: 'cc:' + argv.join(','), stderr: cwd }),
  onOutput: (pid, fd, bytes) => output.push([pid, fd, Buffer.from(bytes).toString()]),
  onHalt: (status) => { halted = status; },
  log: () => {},
});

// The test-side twin of KernelClient.call, minus the park: submit a request,
// then await RPC_DONE (the kernel responds on this same thread's microtasks).
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
// Deferred variant: returns {done, promise} so exits can be injected mid-wait.
function rpcDeferred(pid, op, req) {
  const h = workers.get(pid);
  const { i32, u8 } = page(pid);
  K.writePayload(i32, u8, req);
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
// Fire an RPC without awaiting a response (EXIT never gets one — the kernel
// tears the worker down instead).
function rpcFire(pid, op, req) {
  const h = workers.get(pid);
  const { i32, u8 } = page(pid);
  K.writePayload(i32, u8, req);
  Atomics.store(i32, K.KP_RPC_OP, op);
  Atomics.store(i32, K.KP_RPC_STATE, K.RPC_REQUEST);
  h.msg({ type: 'krpc' });
}
const exitMsg = (pid, code) => workers.get(pid).msg({ type: 'exited', code });
const spawnReq = (p, extra) => Object.assign(
  { path: p, argv: [p], envp: null, cwd: null, actions: [], flags: 0, pgid: 0 }, extra);

(async () => {
  // ---- boot / pid 1 ----
  const initPid = await kernel.boot({ path: '/bin/init', argv: ['init'], envp: ['E=1'], cwd: '/root' });
  check('boot returns pid 1', initPid === 1, String(initPid));
  check('init pgid/sid are 1', kernel.process(1).pgid === 1 && kernel.process(1).sid === 1);

  // ---- spawn + inheritance ----
  let r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a'));
  check('spawn -> pid 2', r.pid === 2, JSON.stringify(r));
  const spec2 = workers.get(2).procSpec;
  check('child inherits envp', JSON.stringify(spec2.envp) === JSON.stringify(['E=1']), JSON.stringify(spec2.envp));
  check('child inherits cwd', spec2.cwd === '/root', spec2.cwd);
  check('child inherits pgid', spec2.pgid === 1, String(spec2.pgid));
  check('child ppid is 1', spec2.ppid === 1);

  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', { envp: ['X=2'], cwd: '/tmp', flags: 1, pgid: 0 }));
  check('spawn -> pid 3', r.pid === 3);
  const spec3 = workers.get(3).procSpec;
  check('explicit envp wins', JSON.stringify(spec3.envp) === JSON.stringify(['X=2']));
  check('explicit cwd wins', spec3.cwd === '/tmp');
  check('SETPGROUP pgid 0 -> own pid', spec3.pgid === 3, String(spec3.pgid));

  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/b', { flags: 1, pgid: 3 }));
  check('spawn -> pid 4', r.pid === 4);
  check('SETPGROUP explicit pgid', workers.get(4).procSpec.pgid === 3);

  r = await rpc(1, K.OP.SPAWN, spawnReq('/no/such'));
  check('missing image -> ENOENT', r.errno === 'ENOENT', JSON.stringify(r));

  // ---- wait: zombie-first, deferred, WNOHANG, ECHILD, selectors ----
  exitMsg(2, 7);
  check('unwaited child is a zombie', kernel.process(2) && kernel.process(2).state === 'zombie');
  r = await rpc(1, K.OP.WAIT, { pid: 2, options: 0 });
  check('wait reaps zombie: pid', r.pid === 2, JSON.stringify(r));
  check('wait reaps zombie: status', r.status === (7 << 8), String(r.status));
  check('zombie fully reaped', kernel.process(2) === null);

  r = await rpc(1, K.OP.WAIT, { pid: 3, options: 1 /* WNOHANG */ });
  check('WNOHANG on running child -> pid 0', r.pid === 0, JSON.stringify(r));

  const d = rpcDeferred(1, K.OP.WAIT, { pid: -3 /* pgid 3 */, options: 0 });
  await tick();
  check('wait(-pgid) defers while children run', d.pending());
  exitMsg(4, 5); // pid 4 is in pgid 3
  r = await d.finish();
  check('wait(-pgid) woken by group member', r.pid === 4 && r.status === (5 << 8), JSON.stringify(r));

  r = await rpc(1, K.OP.WAIT, { pid: 99, options: 0 });
  check('wait on non-child -> ECHILD', r.errno === 'ECHILD', JSON.stringify(r));

  await rpc(1, K.OP.KILL, { pid: 3, sig: 9 });
  r = await rpc(1, K.OP.WAIT, { pid: 3, options: 0 });
  check('SIGKILL + wait cleans up pid 3', r.pid === 3 && r.status === 9, JSON.stringify(r));

  // ---- kill: DFL terminate / IGN / HANDLER / default-ignore / pgroup ----
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a')); // pid 5
  r = await rpc(1, K.OP.KILL, { pid: 5, sig: 15 });
  check('SIGTERM DFL kills', kernel.process(5).state === 'zombie' && workers.get(5).terminated);
  r = await rpc(1, K.OP.WAIT, { pid: 5, options: 0 });
  check('killed child waits as WTERMSIG 15', r.status === 15, String(r.status));

  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a')); // pid 6
  await rpc(6, K.OP.SIGDISP, { sig: 15, kind: 1 /* IGN */ });
  r = await rpc(1, K.OP.KILL, { pid: 6, sig: 15 });
  check('SIGTERM IGN dropped', !r.errno && kernel.process(6).state === 'running');

  await rpc(6, K.OP.SIGDISP, { sig: 10, kind: 2 /* HANDLER */ });
  const before = Atomics.load(page(6).i32, K.KP_DOORBELL);
  r = await rpc(6, K.OP.KILL, { pid: 6, sig: 10 });
  check('caught signal posts SIGPEND bit', (Atomics.load(page(6).i32, K.KP_SIGPEND) & (1 << 9)) !== 0);
  check('caught signal rings doorbell', Atomics.load(page(6).i32, K.KP_DOORBELL) > before);
  check('caught signal leaves target running', kernel.process(6).state === 'running');

  r = await rpc(1, K.OP.KILL, { pid: 6, sig: 17 /* SIGCHLD: default-ignore */ });
  check('SIGCHLD DFL ignored', !r.errno && kernel.process(6).state === 'running');

  r = await rpc(1, K.OP.KILL, { pid: 6, sig: 9 });
  check('SIGKILL always kills', kernel.process(6).state === 'zombie');
  await rpc(1, K.OP.WAIT, { pid: 6, options: 0 });

  // pgroup kill: pids 7,8 in pgid 7; pid 9 outside.
  await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', { flags: 1, pgid: 0 }));      // 7 (pgid 7)
  await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', { flags: 1, pgid: 7 }));      // 8 (pgid 7)
  await rpc(1, K.OP.SPAWN, spawnReq('/bin/a'));                             // 9 (pgid 1)
  r = await rpc(1, K.OP.KILL, { pid: -7, sig: 15 });
  check('kill(-pgid) hits group', kernel.process(7).state === 'zombie' && kernel.process(8).state === 'zombie');
  check('kill(-pgid) spares outsiders', kernel.process(9).state === 'running');
  r = await rpc(1, K.OP.KILL, { pid: -7, sig: 15 });
  check('empty pgroup -> ESRCH', r.errno === 'ESRCH', JSON.stringify(r));
  r = await rpc(1, K.OP.KILL, { pid: 12345, sig: 15 });
  check('unknown pid -> ESRCH', r.errno === 'ESRCH');
  // Signal 0 is the POSIX existence probe (kill(2): error checking only,
  // no signal sent) — hush's `kill -0 PID` liveness idiom rides on it.
  r = await rpc(1, K.OP.KILL, { pid: 9, sig: 0 });
  check('kill(pid, 0) probes a live process -> success, no delivery',
    !r.errno && kernel.process(9).state === 'running', JSON.stringify(r));
  r = await rpc(1, K.OP.KILL, { pid: 12345, sig: 0 });
  check('kill(pid, 0) on an unknown pid -> ESRCH', r.errno === 'ESRCH');
  r = await rpc(1, K.OP.KILL, { pid: -1234, sig: 0 });
  check('kill(-pgid, 0) on an empty pgroup -> ESRCH', r.errno === 'ESRCH');
  r = await rpc(1, K.OP.KILL, { pid: 9, sig: 999 });
  check('bad signal -> EINVAL', r.errno === 'EINVAL');
  r = await rpc(1, K.OP.KILL, { pid: 9, sig: -2 });
  check('negative signal -> EINVAL', r.errno === 'EINVAL');
  await rpc(1, K.OP.WAIT, { pid: -1, options: 0 });
  await rpc(1, K.OP.WAIT, { pid: -1, options: 0 });

  // ---- pgid/sid RPCs ----
  r = await rpc(9, K.OP.GETPGID, { pid: 0 });
  check('getpgid(0) -> own pgid', r.pgid === 1, JSON.stringify(r));
  r = await rpc(9, K.OP.SETSID, {});
  check('setsid -> new session', r.sid === 9 && kernel.process(9).pgid === 9, JSON.stringify(r));
  r = await rpc(9, K.OP.SETSID, {});
  check('setsid as group leader -> EPERM', r.errno === 'EPERM');

  // ---- orphan reparenting: 1 -> 9 -> 10; 9 exits; 10 falls to init ----
  r = await rpc(9, K.OP.SPAWN, spawnReq('/bin/b')); // pid 10, child of 9
  check('grandchild spawned by 9', r.pid === 10 && kernel.process(10).ppid === 9);
  exitMsg(9, 0);
  check('orphan reparented to init', kernel.process(10).ppid === 1);
  await rpc(1, K.OP.WAIT, { pid: 9, options: 0 });
  exitMsg(10, 3);
  r = await rpc(1, K.OP.WAIT, { pid: 10, options: 0 });
  check('init reaps reparented zombie', r.pid === 10 && r.status === (3 << 8), JSON.stringify(r));

  // ---- abnormal termination ----
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a')); // pid 11
  workers.get(11).msg({ type: 'crashed', error: 'boom' });
  r = await rpc(1, K.OP.WAIT, { pid: 11, options: 0 });
  check('crash waits as WTERMSIG SIGSEGV', r.status === 11, String(r.status));

  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a')); // pid 12
  workers.get(12).exitCb(); // channel death, no 'exited'
  r = await rpc(1, K.OP.WAIT, { pid: 12, options: 0 });
  check('silent worker death waits as WTERMSIG SIGSEGV', r.status === 11, String(r.status));

  // ---- output routing + compile ----
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a')); // pid 13
  workers.get(13).msg({ type: 'out', fd: 2, bytes: Buffer.from('oops') });
  check('output routed with pid+fd', JSON.stringify(output.pop()) === JSON.stringify([13, 2, 'oops']));
  r = await rpc(13, K.OP.COMPILE, { argv: ['cc', 'x.c'], cwd: '/w' });
  check('compile hook round-trips', r.exitCode === 3 && r.stdout === 'cc:cc,x.c' && r.stderr === '/w', JSON.stringify(r));
  r = await rpc(13, K.OP.SIGMASK, {});
  check('unimplemented op -> ENOSYS', r.errno === 'ENOSYS');
  exitMsg(13, 0);
  await rpc(1, K.OP.WAIT, { pid: -1, options: 0 });

  // ---- Phase 2: exit handshake, WAIT interruption, blocked-DFL, SIGCHLD ----
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a')); // pid 14
  const d14 = rpcDeferred(1, K.OP.WAIT, { pid: 14, options: 0 });
  await tick();
  rpcFire(14, K.OP.EXIT, { code: 9 });
  r = await d14.finish();
  check('EXIT rpc: waiter gets W_EXITCODE', r.pid === 14 && r.status === (9 << 8), JSON.stringify(r));
  check('EXIT rpc: worker torn down', workers.get(14).terminated);

  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a')); // pid 15
  const d15 = rpcDeferred(1, K.OP.WAIT, { pid: 15, options: 0 });
  await tick();
  check('WAIT parked before intr', d15.pending());
  workers.get(1).msg({ type: 'krpc-intr' });
  r = await d15.finish();
  check('krpc-intr answers EINTR', r.errno === 'EINTR', JSON.stringify(r));
  workers.get(1).msg({ type: 'krpc-intr' }); // no waiter registered: ignored
  await tick();
  check('stray intr ignored', kernel.process(15).state === 'running');

  Atomics.store(page(15).i32, K.KP_SIGBLOCK, 1 << 14); // block SIGTERM (15)
  r = await rpc(1, K.OP.KILL, { pid: 15, sig: 15 });
  check('blocked SIGTERM parks as pending, not death',
    !r.errno && kernel.process(15).state === 'running' &&
    (Atomics.load(page(15).i32, K.KP_SIGPEND) & (1 << 14)) !== 0);

  await rpc(1, K.OP.SIGDISP, { sig: 17, kind: 2 }); // init catches SIGCHLD
  exitMsg(15, 0);
  check('SIGCHLD posted to catching parent on child exit',
    (Atomics.load(page(1).i32, K.KP_SIGPEND) & (1 << 16)) !== 0);
  await rpc(1, K.OP.WAIT, { pid: 15, options: 0 });
  await rpc(1, K.OP.SIGDISP, { sig: 17, kind: 0 });
  Atomics.store(page(1).i32, K.KP_SIGPEND, 0);

  // ---- Phase 4: job control (stop/continue, WUNTRACED/WCONTINUED) ----
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a')); // pid 16
  check('jobctl child spawned', r.pid === 16, JSON.stringify(r));
  await rpc(1, K.OP.KILL, { pid: 16, sig: 19 });    // SIGSTOP
  check('SIGSTOP stops', kernel.process(16).state === 'stopped');
  check('STOP flag posted', (Atomics.load(page(16).i32, K.KP_FLAGS) & K.KF_STOP) !== 0);
  check('stopped worker not terminated', !workers.get(16).terminated);
  await rpc(1, K.OP.KILL, { pid: 16, sig: 19 });
  check('double stop is a no-op', kernel.process(16).state === 'stopped');
  r = await rpc(1, K.OP.WAIT, { pid: 16, options: 2 /* WUNTRACED */ });
  check('WUNTRACED reports the stop', r.pid === 16 && r.status === ((19 << 8) | 0x7f), JSON.stringify(r));
  r = await rpc(1, K.OP.WAIT, { pid: 16, options: 2 | 1 /* WUNTRACED|WNOHANG */ });
  check('stop reported exactly once', r.pid === 0, JSON.stringify(r));
  await rpc(1, K.OP.KILL, { pid: 16, sig: 18 });    // SIGCONT
  check('SIGCONT resumes', kernel.process(16).state === 'running');
  check('STOP flag cleared', (Atomics.load(page(16).i32, K.KP_FLAGS) & K.KF_STOP) === 0);
  r = await rpc(1, K.OP.WAIT, { pid: 16, options: 8 /* WCONTINUED */ });
  check('WCONTINUED reports the continue', r.pid === 16 && r.status === 0xffff, JSON.stringify(r));
  r = await rpc(1, K.OP.WAIT, { pid: 16, options: 8 | 1 });
  check('continue reported exactly once', r.pid === 0, JSON.stringify(r));

  // While pid 1's WAIT is parked it can't issue RPCs (one in flight per
  // process) — deliver the signals through the embedder-facing kill().
  const dj = rpcDeferred(1, K.OP.WAIT, { pid: 16, options: 2 /* WUNTRACED */ });
  await tick();
  check('WUNTRACED wait defers while child runs', dj.pending());
  kernel.kill(16, 20);                              // SIGTSTP at DFL: stop class
  r = await dj.finish();
  check('parked wait answered by a TSTP stop', r.pid === 16 && r.status === ((20 << 8) | 0x7f), JSON.stringify(r));

  const dp = rpcDeferred(1, K.OP.WAIT, { pid: 16, options: 0 });
  await tick();
  check('plain wait ignores a stopped child', dp.pending());
  kernel.kill(16, 18);                              // continue (no WCONTINUED asked)
  await tick();
  check('plain wait ignores a continue too', dp.pending());
  kernel.kill(16, 9);
  r = await dp.finish();
  check('SIGKILL after continue: wait sees the termsig', r.pid === 16 && r.status === 9, JSON.stringify(r));

  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a')); // pid 17
  await rpc(17, K.OP.SIGDISP, { sig: 20, kind: 2 /* HANDLER */ });
  await rpc(1, K.OP.KILL, { pid: 17, sig: 20 });
  check('caught TSTP posts the bit, does not stop',
    kernel.process(17).state === 'running' &&
    (Atomics.load(page(17).i32, K.KP_SIGPEND) & (1 << 19)) !== 0);
  Atomics.store(page(17).i32, K.KP_SIGPEND, 0);
  await rpc(1, K.OP.KILL, { pid: 17, sig: 19 });
  check('SIGSTOP ignores dispositions', kernel.process(17).state === 'stopped');
  await rpc(1, K.OP.KILL, { pid: 17, sig: 15 });    // DFL terminate applies while stopped
  check('SIGTERM terminates a stopped process', kernel.process(17).state === 'zombie');
  r = await rpc(1, K.OP.WAIT, { pid: 17, options: 0 });
  check('stopped-then-termed waits as WTERMSIG 15', r.status === 15, String(r.status));
  Atomics.store(page(1).i32, K.KP_SIGPEND, 0);      // drop the SIGCHLDs this section posted

  // ---- interval timers (todos/0044): SETITIMER/GETITIMER over the SAB ----
  // Real setTimeout drives expiry, so these legs sleep with generous margins
  // (arm 50ms, observe at 150ms) rather than exact deadlines.
  const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
  const ALRM_BIT = 1 << (14 - 1);                   // SIGALRM = 14
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a')); // pid 18
  check('itimer child spawned', r.pid === 18, JSON.stringify(r));
  r = await rpc(18, K.OP.SETITIMER, { which: 1, valueMs: 100, intervalMs: 0 });
  check('ITIMER_VIRTUAL -> EINVAL', r.errno === 'EINVAL', JSON.stringify(r));
  r = await rpc(18, K.OP.SETITIMER, { which: 2, valueMs: 100, intervalMs: 0 });
  check('ITIMER_PROF -> EINVAL', r.errno === 'EINVAL', JSON.stringify(r));
  r = await rpc(18, K.OP.GETITIMER, { which: 1 });
  check('GETITIMER bad which -> EINVAL', r.errno === 'EINVAL', JSON.stringify(r));
  r = await rpc(18, K.OP.GETITIMER, { which: 0 });
  check('disarmed getitimer reads zeros', r.valueMs === 0 && r.intervalMs === 0, JSON.stringify(r));

  await rpc(18, K.OP.SIGDISP, { sig: 14, kind: 2 /* HANDLER */ });
  r = await rpc(18, K.OP.SETITIMER, { which: 0, valueMs: 50, intervalMs: 0 });
  check('arming returns previous (disarmed) values', r.valueMs === 0 && r.intervalMs === 0, JSON.stringify(r));
  r = await rpc(18, K.OP.GETITIMER, { which: 0 });
  check('armed getitimer reads sane remaining', r.valueMs > 0 && r.valueMs <= 50 && r.intervalMs === 0, JSON.stringify(r));
  await sleep(150);
  check('one-shot expiry posts SIGALRM', (Atomics.load(page(18).i32, K.KP_SIGPEND) & ALRM_BIT) !== 0);
  r = await rpc(18, K.OP.GETITIMER, { which: 0 });
  check('one-shot disarms after expiry', r.valueMs === 0 && r.intervalMs === 0, JSON.stringify(r));

  Atomics.store(page(18).i32, K.KP_SIGPEND, 0);
  r = await rpc(18, K.OP.SETITIMER, { which: 0, valueMs: 50, intervalMs: 50 });
  check('interval arm returns previous zeros', r.valueMs === 0 && r.intervalMs === 0, JSON.stringify(r));
  await sleep(150);
  check('interval expiry posts SIGALRM', (Atomics.load(page(18).i32, K.KP_SIGPEND) & ALRM_BIT) !== 0);
  Atomics.store(page(18).i32, K.KP_SIGPEND, 0);
  await sleep(120);
  check('it_interval reloads (fires again)', (Atomics.load(page(18).i32, K.KP_SIGPEND) & ALRM_BIT) !== 0);
  r = await rpc(18, K.OP.GETITIMER, { which: 0 });
  check('reloaded timer stays armed', r.valueMs > 0 && r.intervalMs === 50, JSON.stringify(r));

  Atomics.store(page(18).i32, K.KP_SIGPEND, 0);
  r = await rpc(18, K.OP.SETITIMER, { which: 0, valueMs: 0, intervalMs: 0 });
  check('cancel returns the old armed values', r.valueMs > 0 && r.intervalMs === 50, JSON.stringify(r));
  r = await rpc(18, K.OP.GETITIMER, { which: 0 });
  check('cancelled timer reads zeros', r.valueMs === 0 && r.intervalMs === 0, JSON.stringify(r));
  await sleep(120);
  check('cancelled timer never fires', (Atomics.load(page(18).i32, K.KP_SIGPEND) & ALRM_BIT) === 0);

  // Exit clears the timer: arm with an interval, then exit — the fresh PCB
  // timer must be gone (a stale setTimeout would post bits on a zombie page).
  await rpc(18, K.OP.SETITIMER, { which: 0, valueMs: 50, intervalMs: 50 });
  exitMsg(18, 0);
  check('exit clears the interval timer', kernel.process(18).itimer === null);
  r = await rpc(1, K.OP.WAIT, { pid: 18, options: 0 });
  check('itimer child reaped', r.pid === 18, JSON.stringify(r));

  // Default action (no handler installed) terminates: WIFSIGNALED SIGALRM.
  r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a')); // pid 19
  check('DFL child spawned', r.pid === 19, JSON.stringify(r));
  await rpc(19, K.OP.SETITIMER, { which: 0, valueMs: 40, intervalMs: 0 });
  await sleep(150);
  check('SIGALRM at DFL terminates', kernel.process(19).state === 'zombie');
  r = await rpc(1, K.OP.WAIT, { pid: 19, options: 0 });
  check('termsig is SIGALRM', r.status === 14, JSON.stringify(r));
  Atomics.store(page(1).i32, K.KP_SIGPEND, 0);      // drop this section's SIGCHLDs

  // ---- pid 1 exit halts the system ----
  check('all children reaped pre-halt', kernel.processCount() === 1, String(kernel.processCount()));
  exitMsg(1, 42);
  check('halt reported with init status', halted === (42 << 8), String(halted));
  check('process table empty after halt', kernel.processCount() === 0);
  r = await kernel._spawn(null, spawnReq('/bin/a'));
  check('spawn after halt refused', r.errno === 'ESRCH');

  console.log(failures === 0 ? '\nkernel semantics: PASS' : `\nkernel semantics: ${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
