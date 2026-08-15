#!/usr/bin/env node
'use strict';
// Host-level regression test (todos/0361, reworked for #492): the sleep
// primitives must request the duration they were asked for — no floor, no
// clamp, no unit slip — and, since #492, must do it as a bounded deadline
// loop, never a spin.
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
// #492 changed the block-FS primitive's SHAPE: blockingSleepMs is now a
// monotonic-deadline LOOP over Atomics.wait (OS timer-coalescing leeway wakes
// every timed wait late by min(request/2, ~10ms); requesting 2/3 of the
// remainder compensates, sub-ms tails pass whole). "Requests exactly" is
// therefore a statement about the request SEQUENCE, and the recorder must
// honour the primitive's contract to observe it: a real 'timed-out' return
// means that much time ELAPSED, so the mock advances a VIRTUAL
// performance.now() by exactly the requested duration (the pre-#492 recorder
// returned instantly, which against a deadline loop records parks forever —
// an unfaithful mock, not a product spin: the real cell is private and never
// notified, so real waits can only time out and consume real time). Under
// the zero-leeway virtual clock the invariants are exact, deterministic and
// clock-free:
//
//   * sum(requests) == asked ms   (unit conversion + never-early + no
//     over-sleep, one line — usleep(50000) sums to 50, not 50000 or 0.05)
//   * first request <= asked; requests strictly decrease
//   * a sub-ms ask is ONE request of exactly the asked value (no 1 ms floor)
//   * park count <= PARKS_MAX     (#492's log-bounded-wakes claim, pinned —
//     a spin shows up here as a count explosion)
//   * a zero ask never parks at all (#146, POSIX "shall return immediately")
//
// The suspending imports are unwrapped with the `WebAssembly.Suspending =
// identity` trick from test_pipe_read_block.js, so the async bodies are
// callable directly.
//
// The zero-length nanosleep gap this test used to decline to pin (todos/0365,
// ticket #146) is CLOSED: the native-fs path's `Math.max(1, ms)` floor is
// gone, so nanosleep(0,0) requests 0 ms on both backends — POSIX ("a zero
// request shall return immediately"), matching usleep(0) — and is asserted
// below on both. The kernel-client park flavor needed no change: park(0)
// computes a non-positive deadline and returns 'timeout' at once.
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
// blockingSleepMs() reads Atomics.wait and performance.now off their global
// namespace objects at CALL time, so replacing the properties intercepts
// every park AND its clock. The recorder advances the virtual clock by
// exactly the requested duration — the primitive's own contract for a
// 'timed-out' return — which is what makes the #492 deadline loop terminate
// deterministically (zero leeway: the fewest-progress, most-parks case) with
// zero real wall-clock involvement.
const waits = [];
let vnow = 0;
const realAtomicsWait = Atomics.wait;
const realPerfNow = performance.now;
Atomics.wait = function (arr, idx, val, timeout) {
  waits.push(timeout);
  vnow += timeout;
  return 'timed-out';
};
performance.now = function () { return vnow; };

function blockEnv() {
  const store = new BLOCK_FS.MemoryByteStore(1 << 20);
  const fs = BLOCK_FS.createV4(store, { noDevNodes: true });
  return fs.toWasmEnv(makeCtx());
}

function measureBlock(fn) {
  waits.length = 0;
  vnow = 0;
  fn();
  return waits.slice();
}

// #492 worst case under zero leeway: the remainder shrinks by 1/3 per park
// until <= 1 ms, then one whole-tail park — ceil(log3(ms)) + 2 with float
// slack. 12 covers the largest ask below (2250 ms -> 9 parks) with margin;
// a spin regression overshoots this by orders of magnitude, never by 1.
const PARKS_MAX = 12;
function seqChecks(tag, seq, askedMs) {
  const sum = seq.reduce((a, b) => a + b, 0);
  check(tag + `: requests sum to ${askedMs} ms (unit conversion, no over-sleep)`,
        Math.abs(sum - askedMs) < 1e-6, JSON.stringify(seq));
  check(tag + ': first request <= asked (never over-requests)',
        seq.length > 0 && seq[0] <= askedMs, JSON.stringify(seq));
  check(tag + ': requests strictly decrease (deadline-loop shape)',
        seq.every((v, i) => i === 0 || v < seq[i - 1]), JSON.stringify(seq));
  check(tag + `: park count ${seq.length} <= ${PARKS_MAX} (log-bounded, no spin)`,
        seq.length >= 1 && seq.length <= PARKS_MAX, JSON.stringify(seq));
}

console.log('block-FS flavor (Atomics.wait):');
{
  const env = blockEnv();

  // Sanity: the recorder is live and the primitive is reachable at all. A
  // scan whose "nothing recorded" answer is meaningful needs a positive
  // control, and this is it — without it, an env that lost its sleep
  // primitive entirely would read as "usleep(0) does not park". PASS.
  const control = measureBlock(() => env.usleep(50000));
  check('positive control: usleep(50000) parks at least once', control.length >= 1,
        JSON.stringify(control));
  seqChecks('usleep(50000)', control, 50);

  // THE property the wall-clock test was after.
  const zero = measureBlock(() => { for (let i = 0; i < 20; i++) env.usleep(0); });
  check('usleep(0) x20 never parks', zero.length === 0, JSON.stringify(zero));

  // A sub-millisecond request must stay sub-millisecond: a `Math.max(1, ms)`
  // floor would show up here as 1 even though usleep(0) short-circuits. Under
  // #492 a sub-ms remainder is passed WHOLE, so the sequence is exactly [0.5].
  const sub = measureBlock(() => env.usleep(500));
  check('usleep(500) parks exactly once (sub-ms tail passes whole)',
        sub.length === 1, JSON.stringify(sub));
  eq('usleep(500) requests 0.5 ms (not floored to 1)', sub[0], 0.5);

  eq('usleep(0) returns 0', env.usleep(0), 0);

  const nano = measureBlock(() => env.__nanosleep(0, 50000000));
  seqChecks('nanosleep(0, 50ms)', nano, 50);

  // #146: a zero request is a no-op (POSIX "shall return immediately").
  const nanoZero = measureBlock(() => { for (let i = 0; i < 20; i++) env.__nanosleep(0, 0); });
  check('nanosleep(0,0) x20 never parks (#146)', nanoZero.length === 0,
        JSON.stringify(nanoZero));
  eq('nanosleep(0,0) returns 0', env.__nanosleep(0, 0), 0);

  // ...and a sub-millisecond request is passed through, not floored.
  const nanoSub = measureBlock(() => env.__nanosleep(0, 500000));
  check('nanosleep(0.5ms) parks exactly once', nanoSub.length === 1, JSON.stringify(nanoSub));
  eq('nanosleep(0.5ms) requests 0.5 ms (not floored to 1)', nanoSub[0], 0.5);

  const nanoSec = measureBlock(() => env.__nanosleep(2, 250000000));
  seqChecks('nanosleep(2s, 250ms)', nanoSec, 2250);

  const sec = measureBlock(() => env.sleep(1));
  seqChecks('sleep(1)', sec, 1000);

  // select-as-sleep: empty fd sets, so the whole call IS the timeout.
  const selZero = measureBlock(() => env.__select_impl(0, 0, 0, 0, 0, 0, 1));
  check('select(timeout=0) never parks', selZero.length === 0, JSON.stringify(selZero));

  const sel = measureBlock(() => env.__select_impl(0, 0, 0, 0, 0, 50000, 1));
  seqChecks('select(timeout=50ms)', sel, 50);
}

Atomics.wait = realAtomicsWait;
performance.now = realPerfNow;

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

  // #146: the `Math.max(1, ms)` floor is gone — a zero request asks for 0 ms
  // (POSIX), agreeing with the block-FS no-op and with usleep(0) above. This
  // is the can-fail control for the fix: on the pre-#146 host.js every entry
  // here reads 1.
  const nanoZero = await measureNative(async () => {
    for (let i = 0; i < 20; i++) await env.__nanosleep(0, 0);
  });
  check('nanosleep(0,0) x20 schedules 20 timers', nanoZero.length === 20,
        JSON.stringify(nanoZero));
  check('nanosleep(0,0) requests 0 ms every time (no 1 ms floor, #146)',
        nanoZero.every(ms => ms === 0), JSON.stringify(nanoZero));

  const nanoSub = await measureNative(() => env.__nanosleep(0, 500000));
  eq('nanosleep(0.5ms) requests 0.5 ms (not floored to 1)', nanoSub[0], 0.5);

  const nanoSec = await measureNative(() => env.__nanosleep(2, 250000000));
  eq('nanosleep(2s, 250ms) requests 2250 ms', nanoSec[0], 2250);

  globalThis.setTimeout = realSetTimeout;

  console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll sleep-clamp checks passed');
  process.exit(failures ? 1 : 0);
})();
