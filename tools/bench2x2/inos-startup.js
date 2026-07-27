#!/usr/bin/env node
// bench-2x2: IN-OS measurement by external differencing.
//
// WHY DIFFERENCING. gucOS has no in-guest clock a script can reach: the shipped
// MicroPython port has no `time` module (MICROPY_CONFIG_ROM_LEVEL_MINIMUM, no
// extmod vendored) and its mp_hal_ticks_ms() is a stub returning 0; busybox
// has no `time` applet and its `date` does not implement %N (1s resolution).
// So each quantity is measured as the wall-clock DIFFERENCE between two boots
// that differ only in how many times the thing under test runs. Boot cost is
// constant and cancels.
//
//   node inos-startup.js <repo-root> <reps>
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

const repo = process.argv[2] || path.join(process.env.HOME, 'worktree/c-compiler/bench-2x2');
const REPS = Number(process.argv[3] || 5);

function boot(script) {
  const t0 = process.hrtime.bigint();
  execFileSync('node', [path.join(repo, 'os/boot.js')], {
    input: script + '\n',
    cwd: repo,
    stdio: ['pipe', 'ignore', 'ignore'],
    maxBuffer: 1 << 28,
  });
  return Number(process.hrtime.bigint() - t0) / 1e6; // ms
}

function samples(script, n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(boot(script));
  return out;
}

function stat(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, s.length - 1));
  return { n: s.length, p50: s[Math.floor(s.length / 2)], min: s[0], max: s[s.length - 1], mean, sd };
}

function show(label, st) {
  console.log('  ' + label.padEnd(34)
    + 'n=' + st.n
    + '  p50=' + st.p50.toFixed(1) + ' ms'
    + '  mean=' + st.mean.toFixed(1)
    + '  sd=' + st.sd.toFixed(1)
    + '  [' + st.min.toFixed(1) + '..' + st.max.toFixed(1) + ']');
}

// Repeat a command K times inside one boot.
function times(k, cmd) {
  if (k === 0) return 'echo READY';
  let s = '';
  for (let i = 0; i < k; i++) s += cmd + '; ';
  return s + 'echo READY';
}

const K = 10;

console.log('# in-OS measurement by differencing (repo=' + repo + ')');
console.log('# every figure below is (boot_with_K - boot_with_0) / K');
console.log();

console.log('## baseline: boot with no workload');
const base = stat(samples(times(0, ''), REPS));
show('boot only', base);

console.log();
console.log('## MicroPython startup, in-OS (/bin/python -c pass)');
const withPy = stat(samples(times(K, 'python -c pass'), REPS));
show('boot + ' + K + 'x python -c pass', withPy);
const perStart = (withPy.mean - base.mean) / K;
console.log('  -> per-invocation in-OS startup: ' + perStart.toFixed(1) + ' ms');

// ---- brokered vs self-serving fs -------------------------------------------
// CPython's startup cost is widely assumed to be ~535 stdlib files crossing
// brokered fs RPCs. gucOS's /usr is a SEALED read-only volume that RemoteFS
// answers process-side with ZERO RPCs, while the writable root volume is
// brokered. If the stdlib lives under /usr the premise does not hold, so the
// two are measured separately rather than assumed equal.
const NFILES = 200;
const readScript = (dir) =>
  'i=0; while [ $i -lt ' + NFILES + ' ]; do cat ' + dir + ' > /dev/null; i=$((i+1)); done';

console.log();
console.log('## file-read cost, ' + NFILES + ' reads, /usr (sealed RO, self-served) vs /root (brokered rw)');
const usrBase = stat(samples('echo READY', REPS));
const usrRead = stat(samples(readScript('/usr/share/os-release') + '; echo READY', REPS));
show('boot + ' + NFILES + ' reads of /usr', usrRead);
console.log('  -> per-read /usr: ' + (((usrRead.mean - usrBase.mean) / NFILES) * 1000).toFixed(1) + ' us');

const rootRead = stat(samples('cp /usr/share/os-release /root/probe.txt; '
  + readScript('/root/probe.txt') + '; echo READY', REPS));
show('boot + ' + NFILES + ' reads of /root', rootRead);
console.log('  -> per-read /root: ' + (((rootRead.mean - usrBase.mean) / NFILES) * 1000).toFixed(1) + ' us');
