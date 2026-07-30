#!/usr/bin/env node
// ProcFS (todos/0043): the synthetic /proc volume, driven both directly
// through MountFS (the exact surface Kernel._fsRpc funnels into) and over
// the real SAB RPC protocol with fake workers — deterministic, no threads.
// In-OS acceptance (busybox ps/pgrep/pkill/top parsing it) lives in
// test_os_boot.js.
//
// Run: node tests/kernel/test_procfs.js
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
const rootFs = BLOCK_FS.createV4(new BLOCK_FS.MemoryByteStore(1 << 20));
const mfs = new BLOCK_FS.MountFS({ '/': rootFs, '/proc': procfs });
const kernel = new K.Kernel({
  fs: mfs,
  createWorker,
  loadImage: (p) => images.get(p) || null,
  log: () => {},
});

async function rpc(pid, op, req) {
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
const exitMsg = (pid, code) => workers.get(pid).msg({ type: 'exited', code });
const spawnReq = (p, extra) => Object.assign(
  { path: p, argv: [p], envp: null, cwd: null, actions: [], flags: 0, pgid: 0 }, extra);

function readAll(fs, p) {
  const fd = fs.open(p, 0, 0);
  if (fd === null) return null;
  const chunks = [];
  const buf = new Uint8Array(4096);
  for (;;) {
    const n = fs.read(fd, buf, buf.length);
    if (!n) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  fs.close(fd);
  return Buffer.concat(chunks).toString('binary');
}
function lsDir(fs, p) {
  const h = fs.opendir(p);
  const names = [];
  for (;;) {
    const e = fs.readdir(h);
    if (!e) break;
    if (e.name !== '.' && e.name !== '..') names.push(e.name);
  }
  fs.closedir(h);
  return names;
}

(async () => {
  // ---- binding + static tree ----
  check('Kernel constructor binds ProcFS from the mount table', procfs._kernel === kernel);
  const st = mfs.stat('/proc');
  check('stat /proc is a directory', st && (st.mode & 0xF000) === 0x4000, JSON.stringify(st));
  check('root volume grew the /proc mount-point dir', rootFs.stat('/proc') !== null);
  let names = lsDir(mfs, '/proc');
  const staticFiles = ['loadavg', 'meminfo', 'stat', 'uptime', 'version'];
  check('static files present before boot', staticFiles.every((n) => names.includes(n)), names.join(' '));
  check('no pids before boot', !names.some((n) => /^\d+$/.test(n)), names.join(' '));

  // ---- pids appear on spawn ----
  await kernel.boot({ path: '/bin/init', argv: ['init', '-x'], envp: [], cwd: '/' });
  let r = await rpc(1, K.OP.SPAWN, spawnReq('/bin/a', { argv: ['aaa', 'arg1'] }));
  check('spawned pid 2', r.pid === 2, JSON.stringify(r));
  names = lsDir(mfs, '/proc');
  check('readdir /proc gains 1 and 2', names.includes('1') && names.includes('2'), names.join(' '));

  // ---- per-pid files agree with the process table ----
  const pcb2 = kernel.process(2);
  const status = readAll(mfs, '/proc/2/status');
  check('status Name from argv[0]', /(^|\n)Name:\taaa\n/.test(status), JSON.stringify(status));
  check('status PPid agrees', status.includes('PPid:\t' + pcb2.ppid + '\n'));
  check('status NSpgid agrees', status.includes('NSpgid:\t' + pcb2.pgid + '\n'));
  check('status NSsid agrees', status.includes('NSsid:\t' + pcb2.sid + '\n'));
  check('status State running (no parked RPC)', status.includes('State:\tR (running)'), status);

  const stat2 = readAll(mfs, '/proc/2/stat');
  const rest = stat2.slice(stat2.lastIndexOf(')') + 2).trim().split(/\s+/);
  check('stat comm parenthesized', stat2.startsWith('2 (aaa) '), stat2);
  // rest[0]=state 1=ppid 2=pgid 3=sid (proc(5) fields 3..6)
  check('stat ppid/pgid/sid agree',
    rest[1] === String(pcb2.ppid) && rest[2] === String(pcb2.pgid) && rest[3] === String(pcb2.sid),
    stat2);
  check('stat has 44 fields', stat2.trim().split(/\s+/).length === 44, String(stat2.trim().split(/\s+/).length));

  check('cmdline is argv NUL-joined', readAll(mfs, '/proc/2/cmdline') === 'aaa\0arg1\0');
  check('comm is argv[0] basename', readAll(mfs, '/proc/2/comm') === 'aaa\n');
  check('comm truncates to 15 via init', readAll(mfs, '/proc/1/comm') === 'init\n');

  // ---- system files parse ----
  const uptime = readAll(mfs, '/proc/uptime');
  check('uptime is two floats', /^\d+\.\d\d \d+\.\d\d\n$/.test(uptime), JSON.stringify(uptime));
  const loadavg = readAll(mfs, '/proc/loadavg');
  const lm = /^0\.00 0\.00 0\.00 (\d+)\/(\d+) (\d+)\n$/.exec(loadavg);
  check('loadavg shape', !!lm, JSON.stringify(loadavg));
  check('loadavg total = live procs', lm && lm[2] === '2', loadavg);
  check('loadavg last pid', lm && lm[3] === '2', loadavg);
  const cpustat = readAll(mfs, '/proc/stat');
  check('stat cpu line', /^cpu {2}0 0 0 \d+ 0 0 0 0\n/.test(cpustat), JSON.stringify(cpustat.slice(0, 40)));
  check('stat processes count', cpustat.includes('\nprocesses 2\n'), cpustat);
  const meminfo = readAll(mfs, '/proc/meminfo');
  check('meminfo MemTotal nonzero', /MemTotal:\s+1048576 kB\n/.test(meminfo), meminfo.slice(0, 60));
  check('version reads', /^Linux version /.test(readAll(mfs, '/proc/version')));

  // ---- snapshot semantics: content fixed at open ----
  const snapFd = mfs.open('/proc/loadavg', 0, 0);
  exitMsg(2, 0);                                   // pid 2 exits -> zombie
  await tick();
  const snapBuf = new Uint8Array(256);
  const snapN = mfs.read(snapFd, snapBuf, 256);
  check('open snapshot unaffected by the exit',
    Buffer.from(snapBuf.subarray(0, snapN)).toString() === loadavg);
  mfs.close(snapFd);

  // ---- zombies stay listed (like Linux) until reaped ----
  check('zombie still in readdir', lsDir(mfs, '/proc').includes('2'));
  check('zombie status State Z', readAll(mfs, '/proc/2/status').includes('State:\tZ (zombie)'));
  check('zombie cmdline empty', readAll(mfs, '/proc/2/cmdline') === '');
  r = await rpc(1, K.OP.WAIT, { pid: -1, options: 0 });
  check('reaped pid 2', r.pid === 2, JSON.stringify(r));
  names = lsDir(mfs, '/proc');
  check('readdir /proc loses reaped pid', !names.includes('2'), names.join(' '));
  check('stat of a gone pid ENOENT', mfs.stat('/proc/2/status') === null && mfs._lastError === 'ENOENT');

  // ---- read-only everywhere ----
  check('mkdir EROFS', mfs.mkdir('/proc/x', 0o755) === null && mfs._lastError === 'EROFS');
  check('unlink EROFS', mfs.unlink('/proc/uptime') === null && mfs._lastError === 'EROFS');
  check('symlink EROFS', mfs.symlink('/tmp', '/proc/link') === null && mfs._lastError === 'EROFS');
  check('rename within /proc EROFS', mfs.rename('/proc/uptime', '/proc/downtime') === null && mfs._lastError === 'EROFS');
  check('write-open EACCES', mfs.open('/proc/uptime', 1, 0) === null && mfs._lastError === 'EACCES');
  check('access W_OK EROFS', mfs.access('/proc/uptime', 2) === null && mfs._lastError === 'EROFS');
  check('moduleKey stays null (never Module-cached)', mfs.moduleKey('/proc/uptime') === null);

  // ---- over the real RPC transport (what libc actually does) ----
  r = await rpc(1, K.OP.FS_CHDIR, { path: '/proc' });
  check('chdir /proc works (top does this)', !r.errno, JSON.stringify(r));
  r = await rpc(1, K.OP.FS_OPENDIR, { path: '.' });
  check('FS_OPENDIR lists pids', !r.errno && r.entries.some((e) => e.name === '1'),
    JSON.stringify(r).slice(0, 120));
  r = await rpc(1, K.OP.FS_OPEN, { path: '1/status', flags: 0, mode: 0 });
  check('FS_OPEN cwd-relative', typeof r.fd === 'number', JSON.stringify(r));
  const statusFd = r.fd;
  {
    // FS_READ answers a raw payload; readPayload hands it back as {raw}.
    const resp = await rpc(1, K.OP.FS_READ, { fd: statusFd, count: 512 });
    const text = resp && resp.raw ? Buffer.from(resp.raw).toString() : '';
    check('FS_READ streams status content', text.includes('Name:\tinit'),
      JSON.stringify(String(text).slice(0, 40)));
  }
  await rpc(1, K.OP.FS_CLOSE, { fd: statusFd });

  // ---- GETSID (todos/0043's libc getsid) ----
  r = await rpc(1, K.OP.GETSID, { pid: 0 });
  check('GETSID own sid', r.sid === 1, JSON.stringify(r));
  r = await rpc(1, K.OP.GETSID, { pid: 999 });
  check('GETSID ESRCH', r.errno === 'ESRCH', JSON.stringify(r));

  // ---- unbound ProcFS is an empty tree, not a crash ----
  const lone = new K.ProcFS();
  const loneRoot = BLOCK_FS.createV4(new BLOCK_FS.MemoryByteStore(1 << 20));
  const loneM = new BLOCK_FS.MountFS({ '/': loneRoot, '/proc': lone });
  check('unbound: static files, no pids',
    lsDir(loneM, '/proc').join(' ') === staticFiles.join(' '), lsDir(loneM, '/proc').join(' '));
  check('unbound: pid lookup ENOENT', loneM.stat('/proc/1') === null);

  console.log(failures ? `\n${failures} FAILURES` : '\nall ok');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
