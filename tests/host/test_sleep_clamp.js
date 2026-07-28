#!/usr/bin/env node
'use strict';
// Host-level regression test (todos/0361): the sleep primitives must request
// EXACTLY the duration they were asked for — no floor, no clamp, no unit slip.
//
// This replaces a wall-clock encoding of the same property. The unit tests
// `stdlib/usleep_zero` / `blockfs_usleep_zero` used to run 20 × usleep(0) and
// assert `elapsed_ms < 100`. That is a statement about the MACHINE, not about
// usleep: with four lanes live on this box the suite runs ~2× slower and the
// budget fires with nothing broken (the 0340 merge gate hit exactly that).
// Raising the constant is worse than useless — a real 1 ms clamp over 20 calls
// is only 20 ms, so a 1000 ms budget passes the very bug the test exists for.
//
// So observe the request instead of its wall-clock shadow. Both sleep backends
// bottom out in exactly one primitive, and both are interceptable from plain
// JS with zero clock involvement:
//
//   * native-fs / CLI flavor (JSPI)  -> setTimeout(resolve, ms)
//   * block-FS flavor (no JSPI)      -> Atomics.wait(cell, 0, 0, ms)
//
// We record the `ms` each one is handed. usleep(0) must request 0 ms (or, on
// the block-FS path where a non-positive duration is a documented no-op, not
// park at all) — and usleep(50000) must request 50, which also pins the unit
// conversion the old `elapsed < 500000` upper bounds were groping at.
//
// The suspending imports are unwrapped with the `WebAssembly.Suspending =
// identity` trick from test_pipe_read_block.js, so the async bodies are
// callable directly.
//
// KNOWN GAP, funded by todos/0365 (register L53): the two backends disagree
// about a ZERO-length nanosleep. The block-FS path treats it as a no-op; the
// native-fs path floors it at 1 ms (`Math.max(1, ms)`), so nanosleep(0,0)
// really does sleep a millisecond there, and POSIX says a zero request returns
// immediately. This test deliberately asserts NEITHER answer for that input —
// pinning the floor would bless it as correct — and covers the non-zero
// durations on both. usleep(0) has no such divergence and IS asserted below.
//
// Run: node tests/host/test_sleep_clamp.js

const path = require('path');
const nodeFs = require('fs');

// Unwrap JSPI so the async import bodies are plain callables.
WebAssembly.Suspending = function (f) { return f; };

const ROOT = path.resolve(__dirname, '../..');
const host = require(path.join(ROOT, 'host.js'));
const { createFileSystem, BLOCK_FS } = host;

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name);
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}
function eq(name, actual, expected) {
  check(name, Object.is(actual, expected), `expected ${expected}, got ${actual}`);
}

const memory = new WebAssembly.Memory({ initial: 1 });
function makeCtx() {
  return {
    readString: () => '/unused',
    createVaReader: () => () => 0,
    setErrno: () => {},
    setErrnoName: () => {},
    getMemory: () => memory,
    getIndirectFunctionTable: () => null,
    writeOut: () => {},
    writeErr: () => {},
  };
}

// ---------------------------------------------------------------------------
// Backend A — block-FS flavor: the sync Atomics.wait sleep primitive.
// ---------------------------------------------------------------------------
// blockingSleepMs() reads Atomics.wait off the global Atomics namespace object
// at CALL time, so replacing the property intercepts every park. The recorder
// returns 'timed-out' without waiting, which is what a real timeout returns —
// so control flow above it is unchanged and the test costs no wall-clock time.
const waits = [];
const realAtomicsWait = Atomics.wait;
Atomics.wait = function (arr, idx, val, timeout) {
  waits.push(timeout);
  return 'timed-out';
};

function blockEnv() {
  const store = new BLOCK_FS.MemoryByteStore(1 << 20);
  const fs = BLOCK_FS.createV4(store, { noDevNodes: true });
  return fs.toWasmEnv(makeCtx());
}

function measureBlock(fn) {
  waits.length = 0;
  fn();
  return waits.slice();
}

console.log('block-FS flavor (Atomics.wait):');
{
  const env = blockEnv();

  // Sanity: the recorder is live and the primitive is reachable at all. A
  // scan whose "nothing recorded" answer is meaningful needs a positive
  // control, and this is it — without it, an env that lost its sleep
  // primitive entirely would read as "usleep(0) does not park". PASS.
  const control = measureBlock(() => env.usleep(50000));
  check('positive control: usleep(50000) parks exactly once', control.length === 1,
        JSON.stringify(control));
  eq('usleep(50000) requests 50 ms', control[0], 50);

  // THE property the wall-clock test was after.
  const zero = measureBlock(() => { for (let i = 0; i < 20; i++) env.usleep(0); });
  check('usleep(0) x20 never parks', zero.length === 0, JSON.stringify(zero));

  // A sub-millisecond request must stay sub-millisecond: a `Math.max(1, ms)`
  // floor would show up here as 1 even though usleep(0) short-circuits.
  const sub = measureBlock(() => env.usleep(500));
  check('usleep(500) parks once', sub.length === 1, JSON.stringify(sub));
  eq('usleep(500) requests 0.5 ms (not floored to 1)', sub[0], 0.5);

  eq('usleep(0) returns 0', env.usleep(0), 0);

  const nano = measureBlock(() => env.__nanosleep(0, 50000000));
  check('nanosleep(0, 50ms) parks once', nano.length === 1, JSON.stringify(nano));
  eq('nanosleep(0, 50ms) requests 50 ms', nano[0], 50);

  const nanoSec = measureBlock(() => env.__nanosleep(2, 250000000));
  eq('nanosleep(2s, 250ms) requests 2250 ms', nanoSec[0], 2250);

  const sec = measureBlock(() => env.sleep(1));
  check('sleep(1) parks once', sec.length === 1, JSON.stringify(sec));
  eq('sleep(1) requests 1000 ms', sec[0], 1000);

  // select-as-sleep: empty fd sets, so the whole call IS the timeout.
  const selZero = measureBlock(() => env.__select_impl(0, 0, 0, 0, 0, 0, 1));
  check('select(timeout=0) never parks', selZero.length === 0, JSON.stringify(selZero));

  const sel = measureBlock(() => env.__select_impl(0, 0, 0, 0, 0, 50000, 1));
  check('select(timeout=50ms) parks once', sel.length === 1, JSON.stringify(sel));
  eq('select(timeout=50ms) requests 50 ms', sel[0], 50);
}

Atomics.wait = realAtomicsWait;

// ---------------------------------------------------------------------------
// Backend B — native-fs / CLI flavor: the JSPI setTimeout sleep primitive.
// ---------------------------------------------------------------------------
const timeouts = [];
const realSetTimeout = globalThis.setTimeout;
// Record the requested delay, then fire immediately: the point of the test is
// the REQUEST, and honouring it would put wall-clock back in the loop.
globalThis.setTimeout = function (fn, ms) {
  timeouts.push(ms);
  return realSetTimeout(fn, 0);
};

async function measureNative(fn) {
  timeouts.length = 0;
  await fn();
  return timeouts.slice();
}

(async function () {
  console.log('native-fs flavor (setTimeout):');
  const env = createFileSystem({ fs: nodeFs, ctx: makeCtx() })['c'];  // ENV_KEY

  const control = await measureNative(() => env.usleep(50000));
  check('positive control: usleep(50000) schedules exactly once', control.length === 1,
        JSON.stringify(control));
  eq('usleep(50000) requests 50 ms', control[0], 50);

  const zero = await measureNative(async () => {
    for (let i = 0; i < 20; i++) await env.usleep(0);
  });
  check('usleep(0) x20 schedules 20 timers', zero.length === 20, JSON.stringify(zero));
  check('usleep(0) requests 0 ms every time (no 1 ms floor)',
        zero.every(ms => ms === 0), JSON.stringify(zero));

  const sub = await measureNative(() => env.usleep(500));
  eq('usleep(500) requests 0.5 ms (not floored to 1)', sub[0], 0.5);

  eq('usleep(0) returns 0', await env.usleep(0), 0);

  const nano = await measureNative(() => env.__nanosleep(0, 50000000));
  check('nanosleep(0, 50ms) schedules once', nano.length === 1, JSON.stringify(nano));
  eq('nanosleep(0, 50ms) requests 50 ms', nano[0], 50);

  const nanoSec = await measureNative(() => env.__nanosleep(2, 250000000));
  eq('nanosleep(2s, 250ms) requests 2250 ms', nanoSec[0], 2250);

  globalThis.setTimeout = realSetTimeout;

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll sleep-clamp checks passed');
  process.exit(failures ? 1 : 0);
})();
