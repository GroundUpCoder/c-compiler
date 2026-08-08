#!/usr/bin/env node
'use strict';
// Host-level test (#579): the suite-runner pool's `exclusive` axis, and the
// reason it exists rather than being expressed as a big RAM weight.
//
// The kernel suite's gucman-family rows drive mkpkg over one shared
// content-addressed pool, and two concurrent builds is the todos/0388 race
// that retargeted a sibling's repo mid-read. #579 first tried to prevent that
// with the WEIGHT: charge each row 7 GB, note that 2 x 7 = 14 exceeds the
// 9.6 GB budget of a 16 GB box, and call it serialized.
//
// That is only true on a small enough box. `ramBudgetGb()` is totalmem x 0.6,
// so the budget reaches 14 at totalmem = 14 / 0.6 = 23.34 GiB — a 24 GiB
// machine has a 14.4 GiB budget and admits BOTH rows. The property silently
// disappears exactly where there is most room to run two at once. Leg 3 below
// is the RED CONTROL for that: it reproduces the double-admission using the
// weight alone, so this file fails if anyone ever "simplifies" the exclusion
// back into the constant.
//
// Run: node tests/host/test_pool_exclusive.js

const { runSuite } = require('../lib/suite-runner.js');
const fs = require('fs');
const os = require('os');
const path = require('path');

let failures = 0;
function check(name, cond, detail) {
  if (cond) { process.stdout.write(`  ok   ${name}\n`); return; }
  failures++;
  process.stdout.write(`  FAIL ${name}${detail ? '  ' + detail : ''}\n`);
}

// A fake suite: each "member" is a tiny script that stays alive for a while,
// so overlap is observable. runSuite spawns real children, so plant real files.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-excl-'));
const artifactDir = path.join(dir, 'artifacts');

// The pool's `running` map is internal, so overlap is reconstructed from the
// outside: each child appends a start and an end record to one shared file,
// and the peak of the running sum over that event stream is the answer.
// Deliberately not summary.json mtimes — those have 1 s granularity and would
// not resolve a 300 ms window.
function planted(name, ms, marker) {
  fs.writeFileSync(path.join(dir, name),
    `const fs=require('fs');const M=${JSON.stringify(marker)};\n` +
    `fs.appendFileSync(M, 'S ' + ${JSON.stringify(name)} + ' ' + Date.now() + '\\n');\n` +
    `setTimeout(() => fs.appendFileSync(M, 'E ' + ${JSON.stringify(name)} + ' ' + Date.now() + '\\n'), ${ms});\n`);
}

// Peak simultaneous entries, reconstructed from the S/E event log.
function peakOverlap(marker, filter) {
  const ev = fs.readFileSync(marker, 'utf-8').trim().split('\n')
    .map(l => l.split(' '))
    .filter(p => !filter || filter(p[1]))
    .map(p => ({ kind: p[0], t: +p[2] }))
    .sort((a, b) => a.t - b.t || (a.kind === 'E' ? -1 : 1));
  let cur = 0, peak = 0;
  for (const e of ev) { cur += e.kind === 'S' ? 1 : -1; peak = Math.max(peak, cur); }
  return peak;
}

async function legExclusive() {
  const marker = path.join(dir, 'excl.log');
  fs.writeFileSync(marker, '');
  for (const n of ['test_x1.js', 'test_x2.js', 'test_x3.js']) planted(n, 300, marker);
  // Budget is huge, so the WEIGHT can never be what separates them: only the
  // exclusion key can. This is the 24-GiB-host case, made deterministic.
  await runSuite(
    ['test_x1.js', 'test_x2.js', 'test_x3.js'].map(f => ({ file: f, gb: 7, exclusive: 'k' })),
    { name: 'excl', dir, artifactDir, jobs: 4, timeoutMs: 20000,
      budgetGb: 1000, defaultGb: 7 });
  check('three exclusive rows never overlap, even with an unbounded budget',
    peakOverlap(marker) === 1, `peak overlap ${peakOverlap(marker)}`);
}

async function legDistinctKeysStillParallel() {
  const marker = path.join(dir, 'par.log');
  fs.writeFileSync(marker, '');
  for (const n of ['test_p1.js', 'test_p2.js', 'test_p3.js']) planted(n, 300, marker);
  await runSuite([
    { file: 'test_p1.js', gb: 1, exclusive: 'a' },
    { file: 'test_p2.js', gb: 1, exclusive: 'b' },
    { file: 'test_p3.js', gb: 1 },                 // no key at all
  ], { name: 'par', dir, artifactDir, jobs: 4, timeoutMs: 20000,
       budgetGb: 1000, defaultGb: 1 });
  check('different keys (and no key) still run concurrently — exclusion is per-key',
    peakOverlap(marker) > 1, `peak overlap ${peakOverlap(marker)}`);
}

// 🔴 RED CONTROL: the weight-only scheme this replaced. Same three rows, same
// 7 GB charge, NO exclusion key, and a budget of 14.4 GB — exactly a 24 GiB
// host. If a weight were a serializer this would still be 1.
async function legWeightIsNotASerializer() {
  const marker = path.join(dir, 'red.log');
  fs.writeFileSync(marker, '');
  for (const n of ['test_r1.js', 'test_r2.js', 'test_r3.js']) planted(n, 300, marker);
  await runSuite(
    ['test_r1.js', 'test_r2.js', 'test_r3.js'].map(f => ({ file: f, gb: 7 })),
    { name: 'red', dir, artifactDir, jobs: 4, timeoutMs: 20000,
      budgetGb: 24 * 0.6, defaultGb: 7 });
  const peak = peakOverlap(marker);
  check('RED CONTROL: weight alone does NOT serialize on a 24 GiB host (2 admitted)',
    peak === 2, `peak overlap ${peak} (expected exactly 2: 7+7 <= 14.4 < 21)`);
}

async function legLoneOverweightStillRuns() {
  const marker = path.join(dir, 'lone.log');
  fs.writeFileSync(marker, '');
  planted('test_l1.js', 50, marker);
  // Charge far more than the whole budget: the head must still be admitted,
  // or a heavy row on a small host would deadlock the suite forever.
  const r = await runSuite([{ file: 'test_l1.js', gb: 999, exclusive: 'k' }],
    { name: 'lone', dir, artifactDir, jobs: 4, timeoutMs: 20000,
      budgetGb: 1, defaultGb: 999 });
  check('a lone row heavier than the entire budget still runs (no deadlock)',
    r.failed === 0 && fs.readFileSync(marker, 'utf-8').includes('S test_l1.js'));
}

(async () => {
  process.stdout.write('pool exclusive (suite-runner #579):\n');
  await legExclusive();
  await legDistinctKeysStillParallel();
  await legWeightIsNotASerializer();
  await legLoneOverweightStillRuns();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  if (failures) {
    process.stdout.write(`\npool exclusive: ${failures} FAILED\n`);
    process.exit(1);
  }
  process.stdout.write('\nALL OK\n');
})().catch(e => { process.stderr.write(String(e.stack || e) + '\n'); process.exit(1); });
