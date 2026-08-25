// #184: the host.js CLI wall-clock ceiling — a runaway benchmark-style
// invocation must die on its own, loudly, instead of burning cores for days
// (the todos/0332 orphan pair: two `node host.js` processes, ~70 CPU-hours
// over 2.5 days, killed by hand).
//
// The guard's choke point is host.js ITSELF (runModule wraps the env imports
// with a throttled deadline check when maxWallMs is armed), so every direct
// `node host.js foo.wasm` invocation — current and future — is covered with
// zero per-site adoption. Interactive runs (stdin is a TTY) default to no
// ceiling; non-TTY stdin (the benchmark/scripted shape) defaults to 3600s.
//
// Legs:
//   1. KILL: an import-looping runaway under --max-seconds=1 exits 124 and
//      the message names elapsed time, limit, module path, and the flag.
//   2. SPARE: a healthy short run exits 0 with the ceiling armed — both via
//      an explicit flag and via the non-TTY default.
//   3. DISABLE: --max-seconds=0 really disables — the same runaway is still
//      alive after 3s and only dies when WE kill it.
//   4. USAGE: a negative --max-seconds exits 2.
//
// Run: node tests/host/test_host_ceiling.js
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const { mkdtempOwned } = require('../lib/harness-temp.js');

const ROOT = path.resolve(__dirname, '../..');
const COMPILER = path.join(ROOT, 'compiler.js');
const HOST = path.join(ROOT, 'host.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + extra : '')); failures++; }
}

// The runaway: an import call every iteration (lseek reaches the host's fs
// import layer), so the throttled deadline check runs constantly — the exact
// shape of the 0332 pipe-throughput loops. No output, no exit.
const LOOP_SRC = '#include <unistd.h>\n' +
  'int main(void) { for (;;) (void)lseek(0, 0, SEEK_CUR); return 0; }\n';
const OK_SRC = '#include <stdio.h>\nint main(void) { printf("RAN\\n"); return 0; }\n';

async function main() {
  const tmp = mkdtempOwned('os-hostceiling-');
  const loopC = path.join(tmp, 'loop.c');
  const loopWasm = path.join(tmp, 'loop.wasm');
  const okC = path.join(tmp, 'ok.c');
  const okWasm = path.join(tmp, 'ok.wasm');
  fs.writeFileSync(loopC, LOOP_SRC);
  fs.writeFileSync(okC, OK_SRC);
  cp.execFileSync('node', [COMPILER, loopC, '-o', loopWasm], { stdio: 'pipe' });
  cp.execFileSync('node', [COMPILER, okC, '-o', okWasm], { stdio: 'pipe' });

  // --- Leg 1: the ceiling KILLS a runaway -------------------------------
  const t0 = Date.now();
  const r1 = cp.spawnSync('node', [HOST, loopWasm, '--max-seconds=1'],
    { encoding: 'utf-8', timeout: 20000 });
  const elapsed = Date.now() - t0;
  check('runaway exits on its own (no spawnSync timeout)', r1.signal === null,
    'signal=' + r1.signal);
  check('runaway exit code is 124', r1.status === 124, 'status=' + r1.status);
  check('message names elapsed time and limit',
    /wall-clock ceiling exceeded \(\d+s elapsed, limit 1s\)/.test(r1.stderr),
    JSON.stringify(r1.stderr));
  check('message names the module and the override flag',
    r1.stderr.includes(loopWasm) && r1.stderr.includes('--max-seconds=0'),
    JSON.stringify(r1.stderr));
  check('died promptly (ceiling, not the 20s harness guard)', elapsed < 15000,
    elapsed + 'ms');

  // --- Leg 2: a healthy run is SPARED -----------------------------------
  const r2 = cp.spawnSync('node', [HOST, okWasm, '--max-seconds=30'],
    { encoding: 'utf-8', timeout: 20000 });
  check('healthy run under an explicit ceiling exits 0', r2.status === 0,
    'status=' + r2.status + ' stderr=' + JSON.stringify(r2.stderr));
  check('healthy run output intact', /RAN/.test(r2.stdout), JSON.stringify(r2.stdout));
  // No flag at all: stdin here is a pipe, so the 3600s default arms — and a
  // normal program must neither notice nor slow down into the timeout.
  const r3 = cp.spawnSync('node', [HOST, okWasm], { encoding: 'utf-8', timeout: 20000 });
  check('healthy run under the non-TTY default exits 0', r3.status === 0,
    'status=' + r3.status + ' stderr=' + JSON.stringify(r3.stderr));

  // --- Leg 3: --max-seconds=0 DISABLES (the reaper-safety twin: prove the
  // guard only ever kills its own overrun, never a run someone chose to
  // leave unbounded) ------------------------------------------------------
  // 'ignore', not 'pipe' (#725): nothing ever read these pipes, so the leg
  // was safe only because LOOP_SRC happens to print nothing — a chatty child
  // would wedge on a filled buffer, and pass the aliveAfter assertion for
  // the wrong reason. 'ignore' states the intent the fixture relied on.
  const kid = cp.spawn('node', [HOST, loopWasm, '--max-seconds=0'],
    { stdio: ['ignore', 'ignore', 'ignore'] });
  const aliveAfter = await new Promise((resolve) => {
    let exited = false;
    kid.on('exit', () => { exited = true; });
    setTimeout(() => resolve(!exited), 3000);
  });
  check('--max-seconds=0: runaway still alive after 3s (no ceiling)', aliveAfter);
  kid.kill('SIGKILL');
  const { signal } = await new Promise((resolve) => {
    kid.on('exit', (code, sig) => resolve({ code, signal: sig }));
    if (kid.exitCode !== null) resolve({ code: kid.exitCode, signal: kid.signalCode });
  });
  check('runaway died only by OUR kill', signal === 'SIGKILL', 'signal=' + signal);

  // --- Leg 4: usage error ------------------------------------------------
  const r4 = cp.spawnSync('node', [HOST, okWasm, '--max-seconds=-5'],
    { encoding: 'utf-8', timeout: 20000 });
  check('negative --max-seconds exits 2', r4.status === 2, 'status=' + r4.status);

  console.log(failures === 0 ? 'host ceiling checks OK' : failures + ' FAILED');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
