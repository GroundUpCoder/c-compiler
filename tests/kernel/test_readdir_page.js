#!/usr/bin/env node
// Paginated FS_OPENDIR/FS_READDIR (todos/0241, arch CS2): a directory whose
// entry list exceeds one kernel-page payload must list FULLY, page by page,
// instead of degrading to ENOMEM at _respond's oversize guard. Driven over
// the real SAB RPC protocol with fake workers (the test_procfs.js pattern —
// deterministic, no threads) AND through the real RemoteFS client loop.
//
// Run: node tests/kernel/test_readdir_page.js
'use strict';
const path = require('path');
const K = require(path.resolve(__dirname, '../../kernel.js'));
const host = require(path.resolve(__dirname, '../../host.js'));
const BLOCK_FS = host.BLOCK_FS;

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}
const tick = () => new Promise((r) => setImmediate(r));

// ---- fake worker plumbing (test_kernel.js pattern) ----
const workers = new Map();
function createWorker(procSpec) {
  const h = {
    procSpec, msg: null, exitCb: null, terminated: false,
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

const procfs = new K.ProcFS();
const rootFs = BLOCK_FS.createV4(new BLOCK_FS.MemoryByteStore(8 << 20));
const mfs = new BLOCK_FS.MountFS({ '/': rootFs, '/proc': procfs });
const kernel = new K.Kernel({
  fs: mfs,
  createWorker,
  loadImage: (p) => images.get(p) || null,
  log: () => {},
});

// FS ops answer synchronously inside the krpc dispatch, so a sync rpc()
// works and doubles as a RemoteFS client transport.
function rpc(pid, op, req) {
  const h = workers.get(pid);
  const pcb = kernel.process(pid);
  const i32 = new Int32Array(pcb.page), u8 = new Uint8Array(pcb.page);
  K.writePayload(i32, u8, req);
  Atomics.store(i32, K.KP_RPC_OP, op);
  Atomics.store(i32, K.KP_RPC_STATE, K.RPC_REQUEST);
  h.msg({ type: 'krpc' });
  if (Atomics.load(i32, K.KP_RPC_STATE) !== K.RPC_DONE) {
    throw new Error('rpc 0x' + op.toString(16) + ' did not answer synchronously');
  }
  const resp = K.readPayload(i32, u8);
  Atomics.store(i32, K.KP_RPC_STATE, K.RPC_IDLE);
  return resp;
}
const exitMsg = (pid, code) => workers.get(pid).msg({ type: 'exited', code });
const spawnReq = (p, extra) => Object.assign(
  { path: p, argv: [p], envp: null, cwd: null, actions: [], flags: 0, pgid: 0 }, extra);

// Live backend dir handles (leak probe): BlockFS/ProcFS null out freed slots.
const liveDirHandles = (fs) => fs._dirTable.filter(Boolean).length;

(async () => {
  await kernel.boot({ path: '/bin/init', argv: ['init'], envp: [], cwd: '/' });

  // ---- populate: a big dir (≫ one page) and a small dir (≪ one page) ----
  // Entry JSON is ~45-60 bytes ({"ino":N,"type":8,"name":"f0000.tmp"}), so
  // 3000 entries ≈ 160KB — comfortably over KP_PAYLOAD_CAP (~64KB), under 3
  // pages won't hold it either... it needs 3 pages. Sized from the cap, not
  // a magic constant: assert below that it really exceeds one payload.
  const N = 3000;
  mfs.mkdir('/big', 0o755);
  for (let i = 0; i < N; i++) {
    const fd = mfs.open('/big/f' + String(i).padStart(4, '0') + '.tmp', 0x40 | 1, 0o644);
    if (fd === null) throw new Error('create failed at ' + i);
    mfs.close(fd);
  }
  mfs.mkdir('/small', 0o755);
  for (const n of ['a', 'b', 'c']) {
    const fd = mfs.open('/small/' + n, 0x40 | 1, 0o644);
    mfs.close(fd);
  }

  // Ground truth: direct kernel-side enumeration (order must be preserved).
  const direct = [];
  {
    const h = mfs.opendir('/big');
    for (let e; (e = mfs.readdir(h)) !== null;) direct.push(e.name);
    mfs.closedir(h);
  }
  check('ground truth sees all entries (+. and ..)', direct.length === N + 2,
    String(direct.length));
  const oneShotBytes = new TextEncoder().encode(JSON.stringify({
    entries: direct.map((n) => ({ ino: 1, type: 8, name: n })),
  })).length;
  check('big dir really exceeds one kernel-page payload',
    oneShotBytes > K.KP_PAYLOAD_CAP, oneShotBytes + ' <= ' + K.KP_PAYLOAD_CAP);

  const baselineHandles = liveDirHandles(rootFs);

  // ---- raw RPC protocol: page loop ----
  {
    let r = rpc(1, K.OP.FS_OPENDIR, { path: '/big' });
    check('FS_OPENDIR on a big dir is not ENOMEM', !r.errno, JSON.stringify(r).slice(0, 80));
    check('first page is paginated (more cursor)', r.more !== undefined,
      JSON.stringify(r).slice(0, 80));
    const names = [];
    let pages = 0;
    for (;;) {
      pages++;
      for (const e of r.entries) names.push(e.name);
      if (r.more === undefined) break;
      r = rpc(1, K.OP.FS_READDIR, { dir: r.more });
      if (r.errno) { check('FS_READDIR page fetch', false, r.errno); break; }
    }
    check('multiple pages were needed', pages > 1, String(pages));
    check('full count across pages', names.length === N + 2, String(names.length));
    check('order preserved across pages',
      names.length === direct.length && names.every((n, i) => n === direct[i]));
    check('exhaustion released the kernel-side handle',
      liveDirHandles(rootFs) === baselineHandles, String(liveDirHandles(rootFs)));
    const pcb1 = kernel.process(1);
    check('no parked cursor left on the pcb', !pcb1.dirRpc || pcb1.dirRpc.size === 0);
  }

  // ---- stale cursor → EBADF ----
  {
    const r = rpc(1, K.OP.FS_READDIR, { dir: 999999 });
    check('stale cursor is EBADF', r.errno === 'EBADF', JSON.stringify(r));
  }

  // ---- small dir: single page, no cursor, shape unchanged ----
  {
    const r = rpc(1, K.OP.FS_OPENDIR, { path: '/small' });
    check('small dir answers in one page', !r.errno && r.more === undefined,
      JSON.stringify(r).slice(0, 120));
    const names = r.entries.map((e) => e.name);
    check('small dir lists fully', names.length === 5 &&
      ['a', 'b', 'c'].every((n) => names.includes(n)), names.join(','));
    check('small dir left no handle', liveDirHandles(rootFs) === baselineHandles);
  }

  // ---- through the real RemoteFS client loop (what libc's opendir uses) ----
  {
    const rfs = new K.RemoteFS({ call: (op, req) => rpc(1, op, req) });
    const dh = rfs.opendir('/big');
    check('RemoteFS.opendir on a big dir succeeds', dh !== null, rfs._lastError);
    const names = [];
    for (let e; (e = rfs.readdir(dh)) !== null;) names.push(e.name);
    rfs.closedir(dh);
    check('RemoteFS sees the full listing', names.length === N + 2, String(names.length));
    check('RemoteFS order matches ground truth',
      names.length === direct.length && names.every((n, i) => n === direct[i]));
    check('RemoteFS drain released the handle', liveDirHandles(rootFs) === baselineHandles);
    check('RemoteFS opendir of a missing dir still errors',
      rfs.opendir('/nope') === null && rfs._lastError === 'ENOENT', rfs._lastError);
  }

  // ---- ProcFS through the same paginated path (small, single page) ----
  {
    const r = rpc(1, K.OP.FS_OPENDIR, { path: '/proc' });
    check('ProcFS lists through the paginated path',
      !r.errno && r.more === undefined && r.entries.some((e) => e.name === '1'),
      JSON.stringify(r).slice(0, 120));
    check('ProcFS handle released', liveDirHandles(procfs) === 0);
  }

  // ---- process death mid-pagination releases the parked handle ----
  {
    const s = await rpcAsync(1, K.OP.SPAWN, spawnReq('/bin/a'));   // SPAWN answers async
    check('spawned pid 2', s.pid === 2, JSON.stringify(s));
    const r = rpc(2, K.OP.FS_OPENDIR, { path: '/big' });
    check('pid 2 got a paginated first page', !r.errno && r.more !== undefined);
    check('cursor holds a live backend handle',
      liveDirHandles(rootFs) === baselineHandles + 1, String(liveDirHandles(rootFs)));
    exitMsg(2, 0);                       // dies without draining the cursor
    await tick();
    check('exit released the parked handle',
      liveDirHandles(rootFs) === baselineHandles, String(liveDirHandles(rootFs)));
    await rpcAsync(1, K.OP.WAIT, { pid: -1, options: 0 });
  }

  console.log(failures ? `\n${failures} FAILURES` : '\nall ok');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

// WAIT parks (deferred RPC) — the zombie is already there, so it answers on
// the same dispatch, but go through the async shape for form's sake.
async function rpcAsync(pid, op, req) {
  const h = workers.get(pid);
  const pcb = kernel.process(pid);
  const i32 = new Int32Array(pcb.page), u8 = new Uint8Array(pcb.page);
  K.writePayload(i32, u8, req);
  Atomics.store(i32, K.KP_RPC_OP, op);
  Atomics.store(i32, K.KP_RPC_STATE, K.RPC_REQUEST);
  h.msg({ type: 'krpc' });
  while (Atomics.load(i32, K.KP_RPC_STATE) !== K.RPC_DONE) await tick();
  const resp = K.readPayload(i32, u8);
  Atomics.store(i32, K.KP_RPC_STATE, K.RPC_IDLE);
  return resp;
}
