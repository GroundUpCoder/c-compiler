#!/usr/bin/env node
'use strict';
// Test flake / under-load gate (todos/0147).
//
// Runs the historically-flaky, sleep-sensitive test files REPEATEDLY and under
// CPU contention to prove they stay event-clean. This is the gate to run after
// any new e2e/browser test lands (and periodically as a dogfood tripwire): a
// FLAKY verdict here means a fixed-sleep / timing dependency crept back in that
// the idle box's slack was hiding.
//
//   node tests/flake.js                 # default tripwire: --repeat 3 --under-load
//   node tests/flake.js --repeat 5      # hammer harder
//   node tests/flake.js --no-under-load # repeat without the CPU load generators
//   node tests/flake.js --kernel-only   # skip the browser leg (no Playwright)
//   node tests/flake.js --filter=term   # further narrow the tripwire set
//
// Mechanism lives in tests/lib/suite-runner.js (--repeat N, --under-load[=N],
// comma-OR --filter); this script just names the tripwire SET and wires the
// flags. Each leg runs its files TOGETHER (one runner, comma-OR filter) so
// they contend against each other on top of the busy-loop generators.
//
// The tripwire set = the files whose sync was a fixed `sleep` before the
// 0083/0154/0155 event-wait sweep (the documented 0074 os-doom flake + the
// boot-heavy wm/term/app e2es). Grep the runners for `'sleep ` to see what
// still carries an annotated timing subject.

const { spawnSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// [runner, comma-OR filter, optional?] — optional legs (browser) degrade to a
// SKIP when the runner can't launch (Playwright absent), never a hard fail.
const LEGS = [
  { name: 'kernel', cmd: ['tests/kernel/run.js'],
    filter: 'wm_service_e2e,term_e2e,os_apps_e2e', optional: false },
  { name: 'browser', cmd: ['tests/browser/os-sweep.mjs'],
    filter: 'os-doom,os-term', optional: true },
];

function parse(argv) {
  const o = { repeat: 3, underLoad: true, kernelOnly: false, filter: null, extra: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repeat') o.repeat = parseInt(argv[++i], 10);
    else if (a.startsWith('--repeat=')) o.repeat = parseInt(a.slice(9), 10);
    else if (a === '--no-under-load') o.underLoad = false;
    else if (a === '--under-load') o.underLoad = true;
    else if (a.startsWith('--under-load=')) o.underLoad = a.slice(13);
    else if (a === '--kernel-only') o.kernelOnly = true;
    else if (a === '--filter') o.filter = argv[++i];
    else if (a.startsWith('--filter=')) o.filter = a.slice(9);
    else if (a === '-h' || a === '--help') o.help = true;
    else o.extra.push(a);              // e.g. --timeout=MS, forwarded verbatim
  }
  if (!Number.isInteger(o.repeat) || o.repeat < 1) o.repeat = 3;
  return o;
}

function usage() {
  process.stdout.write(`Test flake / under-load gate (todos/0147).

  node tests/flake.js [--repeat N] [--no-under-load] [--kernel-only] [--filter=S]

  --repeat N        runs per file (default 3)
  --no-under-load   skip the CPU-contention generators
  --under-load=N    N busy-loop generators (default: one per core)
  --kernel-only     skip the browser leg (use where Playwright is absent)
  --filter=S        intersect the tripwire set with S (comma = OR)

Legs: kernel (wm_service/term/os_apps e2es), browser (os-doom/os-term).
A FLAKY verdict = a fixed-sleep/timing dependency regressed.
`);
}

// Combine the tripwire filter with a user --filter. Both are comma-OR sets;
// the intersection keeps only tripwire files that also match the user's set.
function narrow(tripwire, user) {
  if (!user) return tripwire;
  const u = user.split(',').map(s => s.trim()).filter(Boolean);
  const keep = tripwire.split(',').map(s => s.trim())
    .filter(t => u.some(x => t.includes(x) || x.includes(t)));
  return keep.join(',');
}

function main() {
  const o = parse(process.argv.slice(2));
  if (o.help) { usage(); process.exit(0); }

  const underLoadArg = o.underLoad === false ? null
    : (o.underLoad === true ? '--under-load' : `--under-load=${o.underLoad}`);

  const legs = o.kernelOnly ? LEGS.filter(l => l.name === 'kernel') : LEGS;
  const results = [];
  const t0 = Date.now();

  for (const leg of legs) {
    const filter = narrow(leg.filter, o.filter);
    if (!filter) { results.push({ leg: leg.name, status: 'skip', note: 'no tripwire file matched --filter' }); continue; }
    const args = [...leg.cmd, `--filter=${filter}`, `--repeat=${o.repeat}`, ...o.extra];
    if (underLoadArg) args.push(underLoadArg);
    process.stdout.write(`\n\x1b[1m━━━ flake gate: ${leg.name} leg ━━━\x1b[0m\n$ node ${args.join(' ')}\n\n`);
    const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' });
    if (r.error) {
      // Couldn't launch the runner at all — optional legs skip, required fail.
      results.push({ leg: leg.name, status: leg.optional ? 'skip' : 'fail', note: `could not launch: ${r.error.message}` });
    } else {
      results.push({ leg: leg.name, status: r.status === 0 ? 'pass' : 'fail', exit: r.status });
    }
  }

  process.stdout.write(`\n\x1b[1m━━━ flake gate summary (${o.repeat}× each${underLoadArg ? ', under load' : ''}) ━━━\x1b[0m\n`);
  for (const r of results) {
    const tag = r.status === 'pass' ? '\x1b[32mok  \x1b[0m'
              : r.status === 'skip' ? '\x1b[33mskip\x1b[0m'
              : '\x1b[31mFAIL\x1b[0m';
    process.stdout.write(`  ${tag} ${r.leg.padEnd(8)}${r.note ? `  (${r.note})` : ''}\n`);
  }
  const fail = results.some(r => r.status === 'fail');
  process.stdout.write(`\n  ${fail ? '\x1b[31mFLAKE GATE FAILED\x1b[0m' : '\x1b[32mflake gate green\x1b[0m'}  (${((Date.now() - t0) / 1000).toFixed(1)}s)\n`);
  process.exit(fail ? 1 : 0);
}

main();
