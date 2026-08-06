#!/usr/bin/env node
// Live interactive stdin over a SharedArrayBuffer ring — block-FS (no-JSPI)
// path. Drives the stdin sab directly: pre-fill → read/select see bytes;
// empty → a producer on a second thread pushes + notifies → read/select wake
// via Atomics.wait. Also covers EOF, the select-timeout-vs-input race, winsz,
// and termios-mode publication. The in-process unit runner can't feed live
// stdin, so these JS tests are the coverage for the sab path.
'use strict';

var host = require('../../host.js');
var BLOCK_FS = host.BLOCK_FS;
var MemoryByteStore = BLOCK_FS.MemoryByteStore;
var { Worker } = require('worker_threads');

var passed = 0;
var failed = 0;
var liveWorkers = [];

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (e) {
    failed++;
    console.error('FAIL: ' + name);
    console.error('  ' + (e.stack || e.message));
  }
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function assertEq(a, b, msg) { if (a !== b) throw new Error((msg || 'assertEq') + ': ' + a + ' !== ' + b); }

function makeFS() {
  var store = new MemoryByteStore(1024 * 1024);
  return { fs: BLOCK_FS.create(store), store: store };
}

// Stdin sab layout — MUST match host.js (SI_* constants there).
var SEQ = 0, AVAIL = 1, WRITEPOS = 2, READPOS = 3, EOF = 4, COLS = 5, ROWS = 6, TERMIOS = 7;
var HDR = 32;

function makeStdinSab(ringSize) {
  ringSize = ringSize || 4096;
  return new SharedArrayBuffer(HDR + ringSize);
}

// Producer-side push (same logic the page will run), used inline + in workers.
function pushStdin(sab, bytes) {
  var ctrl = new Int32Array(sab, 0, 8);
  var ring = new Uint8Array(sab, HDR, sab.byteLength - HDR);
  var size = ring.length;
  var wp = Atomics.load(ctrl, WRITEPOS);
  for (var i = 0; i < bytes.length; i++) ring[(wp + i) % size] = bytes[i];
  Atomics.store(ctrl, WRITEPOS, (wp + bytes.length) % size);
  Atomics.add(ctrl, AVAIL, bytes.length);
  Atomics.add(ctrl, SEQ, 1);
  Atomics.notify(ctrl, SEQ);
}
function eofStdin(sab) {
  var ctrl = new Int32Array(sab, 0, 8);
  Atomics.store(ctrl, EOF, 1);
  Atomics.add(ctrl, SEQ, 1);
  Atomics.notify(ctrl, SEQ);
}

// Spawn a producer that, after delayMs, pushes bytes and/or signals EOF from
// another thread. Returns the worker so the test can terminate it.
var PRODUCER_SRC = `
const { workerData } = require('worker_threads');
const { sab, delayMs, push, eof } = workerData;
const HDR = 32, SEQ = 0, AVAIL = 1, WRITEPOS = 2, EOFI = 4;
const ctrl = new Int32Array(sab, 0, 8);
const ring = new Uint8Array(sab, HDR, sab.byteLength - HDR);
setTimeout(() => {
  if (push) {
    const size = ring.length;
    const wp = Atomics.load(ctrl, WRITEPOS);
    for (let i = 0; i < push.length; i++) ring[(wp + i) % size] = push[i];
    Atomics.store(ctrl, WRITEPOS, (wp + push.length) % size);
    Atomics.add(ctrl, AVAIL, push.length);
    Atomics.add(ctrl, SEQ, 1);
    Atomics.notify(ctrl, SEQ);
  }
  if (eof) { Atomics.store(ctrl, EOFI, 1); Atomics.add(ctrl, SEQ, 1); Atomics.notify(ctrl, SEQ); }
}, delayMs);
`;

function spawnProducer(sab, opts) {
  var w = new Worker(PRODUCER_SRC, { eval: true, workerData: { sab: sab, delayMs: opts.delayMs, push: opts.push || null, eof: !!opts.eof } });
  w.unref();
  liveWorkers.push(w);
  return w;
}

// Minimal toWasmEnv ctx so __select_impl / __ioctl_tiocgwinsz / __tcsetattr can
// marshal through a real WebAssembly.Memory.
function makeEnv(fs, sab) {
  var mem = new WebAssembly.Memory({ initial: 1 });
  var lastErr = '';
  var env = fs.toWasmEnv({
    readString: function () { return ''; },
    setErrnoName: function (n) { lastErr = n; },
    getMemory: function () { return mem; },
    writeOut: function () {}, writeErr: function () {},
    stdinSab: sab,
  });
  return { env: env, mem: mem, getErr: function () { return lastErr; } };
}

// select() on fd 0 only. timeoutMs<0 → no timeout (block forever).
function selectStdin(env, mem, timeoutMs) {
  var dv = new DataView(mem.buffer);
  var R = 128;
  dv.setInt32(R, 1, true); dv.setInt32(R + 4, 0, true); // request fd 0 readable
  var hasTimeout = timeoutMs >= 0 ? 1 : 0;
  var sec = hasTimeout ? Math.floor(timeoutMs / 1000) : 0;
  var usec = hasTimeout ? (timeoutMs % 1000) * 1000 : 0;
  var count = env.__select_impl(1, R, 0, 0, sec, usec, hasTimeout);
  var ready = (dv.getInt32(R, true) & 1) !== 0;
  return { count: count, ready: ready };
}

// ----------------------------------------------------------------------
// read(0) over the sab
// ----------------------------------------------------------------------

test('read(0): pre-filled sab returns bytes synchronously', function () {
  var sab = makeStdinSab();
  var fs = makeFS().fs;
  fs.setStdinSab(sab);
  pushStdin(sab, [104, 105]); // "hi"
  var buf = new Uint8Array(16);
  var n = fs.read(0, buf, 16);
  assertEq(n, 2, 'read 2 bytes');
  assertEq(buf[0], 104); assertEq(buf[1], 105);
  // Subsequent reads see an empty ring; with EOF unset a second read would
  // block, so don't call it here.
  assertEq(Atomics.load(new Int32Array(sab, 0, 8), AVAIL), 0, 'avail drained to 0');
});

test('read(0): respects count (partial drain), leaves remainder', function () {
  var sab = makeStdinSab();
  var fs = makeFS().fs;
  fs.setStdinSab(sab);
  pushStdin(sab, [1, 2, 3, 4, 5]);
  var buf = new Uint8Array(2);
  assertEq(fs.read(0, buf, 2), 2, 'first read 2');
  assertEq(buf[0], 1); assertEq(buf[1], 2);
  var buf2 = new Uint8Array(8);
  assertEq(fs.read(0, buf2, 8), 3, 'second read drains 3');
  assertEq(buf2[0], 3); assertEq(buf2[1], 4); assertEq(buf2[2], 5);
});

test('read(0): EOF (empty + eof flag) returns 0 without blocking', function () {
  var sab = makeStdinSab();
  var fs = makeFS().fs;
  fs.setStdinSab(sab);
  eofStdin(sab);
  var buf = new Uint8Array(16);
  assertEq(fs.read(0, buf, 16), 0, 'EOF → 0');
});

test('read(0): blocks until a producer pushes from another thread', function () {
  var sab = makeStdinSab();
  var fs = makeFS().fs;
  fs.setStdinSab(sab);
  spawnProducer(sab, { delayMs: 80, push: [104, 105, 10] }); // "hi\n"
  var buf = new Uint8Array(16);
  var t0 = Date.now();
  var n = fs.read(0, buf, 16); // parks on Atomics.wait
  var dt = Date.now() - t0;
  assertEq(n, 3, 'woke and read 3 bytes');
  assertEq(buf[0], 104); assertEq(buf[1], 105); assertEq(buf[2], 10);
  assert(dt >= 50, 'read actually blocked ~80ms (got ' + dt + 'ms)');
});

test('read(0): blocked reader wakes on EOF from another thread (returns 0)', function () {
  var sab = makeStdinSab();
  var fs = makeFS().fs;
  fs.setStdinSab(sab);
  spawnProducer(sab, { delayMs: 80, eof: true });
  var buf = new Uint8Array(16);
  var t0 = Date.now();
  var n = fs.read(0, buf, 16);
  var dt = Date.now() - t0;
  assertEq(n, 0, 'EOF wakeup → 0');
  assert(dt >= 50, 'blocked until EOF (got ' + dt + 'ms)');
});

test('read(0): no sab wired → EOF (0), old behaviour preserved', function () {
  var fs = makeFS().fs; // no setStdinSab
  var buf = new Uint8Array(16);
  assertEq(fs.read(0, buf, 16), 0, 'no sab → 0');
});

// ----------------------------------------------------------------------
// select() readiness over the sab
// ----------------------------------------------------------------------

test('select: pre-filled stdin reports ready (poll, 0 timeout)', function () {
  var sab = makeStdinSab();
  var fs = makeFS().fs;
  var e = makeEnv(fs, sab);
  pushStdin(sab, [65]);
  var r = selectStdin(e.env, e.mem, 0);
  assertEq(r.count, 1, 'count 1'); assert(r.ready, 'stdin ready');
});

test('select: empty stdin not ready (poll, 0 timeout)', function () {
  var sab = makeStdinSab();
  var fs = makeFS().fs;
  var e = makeEnv(fs, sab);
  var r = selectStdin(e.env, e.mem, 0);
  assertEq(r.count, 0, 'count 0'); assert(!r.ready, 'stdin not ready');
});

test('select: EOF stdin reports ready (read would return 0)', function () {
  var sab = makeStdinSab();
  var fs = makeFS().fs;
  var e = makeEnv(fs, sab);
  eofStdin(sab);
  var r = selectStdin(e.env, e.mem, 0);
  assertEq(r.count, 1, 'count 1'); assert(r.ready, 'EOF → ready');
});

test('select: empty + timeout, no input → times out not-ready', function () {
  var sab = makeStdinSab();
  var fs = makeFS().fs;
  var e = makeEnv(fs, sab);
  var t0 = Date.now();
  var r = selectStdin(e.env, e.mem, 60);
  var dt = Date.now() - t0;
  assertEq(r.count, 0, 'timed out, count 0'); assert(!r.ready, 'not ready');
  assert(dt >= 40, 'waited out the timeout (got ' + dt + 'ms)');
});

test('select: empty + timeout, input arrives → wakes ready before timeout', function () {
  var sab = makeStdinSab();
  var fs = makeFS().fs;
  var e = makeEnv(fs, sab);
  spawnProducer(sab, { delayMs: 60, push: [120] }); // "x" at 60ms
  var t0 = Date.now();
  var r = selectStdin(e.env, e.mem, 2000); // 2s timeout, should wake at ~60ms
  var dt = Date.now() - t0;
  assertEq(r.count, 1, 'woke ready'); assert(r.ready, 'stdin ready');
  assert(dt < 1500, 'woke well before the 2s timeout (got ' + dt + 'ms)');
});

test('select: blocking (no timeout) wakes on input from another thread', function () {
  var sab = makeStdinSab();
  var fs = makeFS().fs;
  var e = makeEnv(fs, sab);
  spawnProducer(sab, { delayMs: 70, push: [121] });
  var t0 = Date.now();
  var r = selectStdin(e.env, e.mem, -1); // block forever until ready
  var dt = Date.now() - t0;
  assertEq(r.count, 1, 'woke'); assert(r.ready, 'ready');
  assert(dt >= 40, 'actually blocked (got ' + dt + 'ms)');
});

test('select: no sab wired → stdin always ready (old behaviour)', function () {
  var fs = makeFS().fs;
  var e = makeEnv(fs, null);
  var r = selectStdin(e.env, e.mem, 0);
  assertEq(r.count, 1, 'count 1'); assert(r.ready, 'always ready without sab');
});

// ----------------------------------------------------------------------
// winsz + termios over the sab
// ----------------------------------------------------------------------

test('TIOCGWINSZ: reads cols/rows from the sab', function () {
  var sab = makeStdinSab();
  var fs = makeFS().fs;
  var e = makeEnv(fs, sab);
  var ctrl = new Int32Array(sab, 0, 8);
  Atomics.store(ctrl, COLS, 120);
  Atomics.store(ctrl, ROWS, 40);
  var dv = new DataView(e.mem.buffer);
  e.env.__ioctl_tiocgwinsz(0, 16, 24); // rows_ptr=16, cols_ptr=24
  assertEq(dv.getInt32(16, true), 40, 'rows from sab');
  assertEq(dv.getInt32(24, true), 120, 'cols from sab');
});

test('TIOCGWINSZ: no sab → 80x24 default', function () {
  var fs = makeFS().fs;
  var e = makeEnv(fs, null);
  var dv = new DataView(e.mem.buffer);
  e.env.__ioctl_tiocgwinsz(0, 16, 24);
  assertEq(dv.getInt32(16, true), 24, 'rows default');
  assertEq(dv.getInt32(24, true), 80, 'cols default');
});

test('tcsetattr: publishes raw/echo/opost bitfield to the sab', function () {
  var sab = makeStdinSab();
  var fs = makeFS().fs;
  var e = makeEnv(fs, sab);
  var ctrl = new Int32Array(sab, 0, 8);
  // Canonical+echo+opost: lflag has ICANON(0x100)|ECHO(0x8), oflag OPOST(0x1).
  e.env.__tcsetattr(0, 0, 0, 0x1, 0, 0x100 | 0x8);
  assertEq(Atomics.load(ctrl, TERMIOS), 1 | 2 | 4, 'icanon|echo|opost');
  // Raw mode: clear ICANON/ECHO/OPOST.
  e.env.__tcsetattr(0, 0, 0, 0, 0, 0);
  assertEq(Atomics.load(ctrl, TERMIOS), 0, 'raw → 0');
});

// ----------------------------------------------------------------------

for (var i = 0; i < liveWorkers.length; i++) { try { liveWorkers[i].terminate(); } catch (e) {} }
console.log('\nstdin-sab: Passed: ' + passed + '  Failed: ' + failed);
process.exitCode = failed ? 1 : 0;
