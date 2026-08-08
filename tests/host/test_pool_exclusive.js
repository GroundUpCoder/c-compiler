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
// disappears exactly where there is most room to run two at once.
//
// 🔴 WHICH LEG IS THE SAFETY NET. Legs 1 and 2b are the REGRESSION CONTROLS:
// neuter `exclusiveFree()` and their `peak === 1` assertions fail. Leg 2a is a
// DEMONSTRATION, not a control — it supplies no keys, so it reads the same
// (peak 2) under both the old and the new scheduler and CANNOT fail on this
// bug. It earns its place by pinning the ARITHMETIC of the defect (7 + 7 fits
// a 24 GiB host's budget) directly beside 2b, which runs identical rows at an
// identical budget WITH keys and gets 1. The pair is the argument in two
// numbers. Do NOT delete leg 1 as "redundant with 2a".
//
// Verified by mutation, not by reading: with `exclusiveFree` forced to `true`,
// legs 1 and 2b go red (peak 3 and 2) and legs 2a/3 stay green.
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
// One artifact dir PER LEG. Sharing one made each leg's summary.json carry the
// previous legs' rows forward as `carried`, so it reported nonsense like
// `recorded: 10, total: 1`. The scheduling assertions never read those files —
// but a test that emits self-contradictory evidence teaches the next reader to
// distrust artifacts, which is the opposite of what this estate needs.
let legN = 0;
const legDir = (name) => path.join(dir, `artifacts-${++legN}-${name}`);

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

// LEG 1 — 🔴 REGRESSION CONTROL. The budget is effectively unbounded, so the
// WEIGHT cannot be what separates these rows; only the exclusion key can.
// Neuter exclusiveFree() and this reads 3.
async function leg1_exclusiveHoldsWithoutBudgetHelp() {
  const marker = path.join(dir, 'excl.log');
  fs.writeFileSync(marker, '');
  for (const n of ['test_x1.js', 'test_x2.js', 'test_x3.js']) planted(n, 300, marker);
  await runSuite(
    ['test_x1.js', 'test_x2.js', 'test_x3.js'].map(f => ({ file: f, gb: 7, exclusive: 'k' })),
    { name: 'excl', dir, artifactDir: legDir('excl'), jobs: 4, timeoutMs: 20000,
      budgetGb: 1000, defaultGb: 7 });
  const peak = peakOverlap(marker);
  check('CONTROL: three same-key rows never overlap, with an unbounded budget',
    peak === 1, `peak overlap ${peak} (expected 1)`);
}

// LEG 2a — DEMONSTRATION ONLY, NOT A CONTROL. Reads 2 under the old scheduler
// and under the new one alike, because it supplies no keys. It exists to pin
// the arithmetic of the defect next to 2b.
async function leg2a_weightAloneDoesNotSerialize() {
  const marker = path.join(dir, 'red.log');
  fs.writeFileSync(marker, '');
  for (const n of ['test_r1.js', 'test_r2.js', 'test_r3.js']) planted(n, 300, marker);
  await runSuite(
    ['test_r1.js', 'test_r2.js', 'test_r3.js'].map(f => ({ file: f, gb: 7 })),
    { name: 'red', dir, artifactDir: legDir('weight-only'), jobs: 4, timeoutMs: 20000,
      budgetGb: 24 * 0.6, defaultGb: 7 });
  const peak = peakOverlap(marker);
  check('DEMO (not a control): weight alone admits 2 on a 24 GiB host',
    peak === 2, `peak overlap ${peak} (expected exactly 2: 7+7 <= 14.4 < 21)`);
}

// LEG 2b — 🔴 REGRESSION CONTROL, and the direct answer to 2a: identical rows,
// identical 24 GiB budget, keys added. 2a says 2, this says 1, and the only
// difference is the key. Neuter exclusiveFree() and this reads 2.
async function leg2b_keysFixTheSame24GiBHost() {
  const marker = path.join(dir, 'fix.log');
  fs.writeFileSync(marker, '');
  for (const n of ['test_f1.js', 'test_f2.js', 'test_f3.js']) planted(n, 300, marker);
  await runSuite(
    ['test_f1.js', 'test_f2.js', 'test_f3.js'].map(f => ({ file: f, gb: 7, exclusive: 'k' })),
    { name: 'fix', dir, artifactDir: legDir('keyed-24g'), jobs: 4, timeoutMs: 20000,
      budgetGb: 24 * 0.6, defaultGb: 7 });
  const peak = peakOverlap(marker);
  check('CONTROL: the SAME rows at the SAME 24 GiB budget, keyed, never overlap',
    peak === 1, `peak overlap ${peak} (expected 1)`);
}

async function leg3_distinctKeysStillParallel() {
  const marker = path.join(dir, 'par.log');
  fs.writeFileSync(marker, '');
  for (const n of ['test_p1.js', 'test_p2.js', 'test_p3.js']) planted(n, 300, marker);
  await runSuite([
    { file: 'test_p1.js', gb: 1, exclusive: 'a' },
    { file: 'test_p2.js', gb: 1, exclusive: 'b' },
    { file: 'test_p3.js', gb: 1 },                 // no key at all
  ], { name: 'par', dir, artifactDir: legDir('per-key'), jobs: 4, timeoutMs: 20000,
       budgetGb: 1000, defaultGb: 1 });
  const peak = peakOverlap(marker);
  check('different keys (and no key) still run concurrently — exclusion is per-key',
    peak > 1, `peak overlap ${peak}`);
}

async function leg4_loneOverweightStillRuns() {
  const marker = path.join(dir, 'lone.log');
  fs.writeFileSync(marker, '');
  planted('test_l1.js', 50, marker);
  // Charge far more than the whole budget: the head must still be admitted,
  // or a heavy row on a small host would deadlock the suite forever.
  const r = await runSuite([{ file: 'test_l1.js', gb: 999, exclusive: 'k' }],
    { name: 'lone', dir, artifactDir: legDir('lone'), jobs: 4, timeoutMs: 20000,
      budgetGb: 1, defaultGb: 999 });
  check('a lone row heavier than the entire budget still runs (no deadlock)',
    r.failed === 0 && fs.readFileSync(marker, 'utf-8').includes('S test_l1.js'));
}

// Falsy keys must exclude like any other key — '' and 0 are legitimate values
// and must not be read as "unkeyed" (the `== null` test in exclusiveFree).
async function leg5_falsyKeysStillExclude() {
  const marker = path.join(dir, 'falsy.log');
  fs.writeFileSync(marker, '');
  for (const n of ['test_z1.js', 'test_z2.js']) planted(n, 300, marker);
  await runSuite(
    ['test_z1.js', 'test_z2.js'].map(f => ({ file: f, gb: 1, exclusive: '' })),
    { name: 'falsy', dir, artifactDir: legDir('falsy'), jobs: 4, timeoutMs: 20000,
      budgetGb: 1000, defaultGb: 1 });
  const peak = peakOverlap(marker);
  check('an empty-string key excludes like any other (not read as "no key")',
    peak === 1, `peak overlap ${peak} (expected 1)`);
}

(async () => {
  process.stdout.write('pool exclusive (suite-runner #579):\n');
  await leg1_exclusiveHoldsWithoutBudgetHelp();
  await leg2a_weightAloneDoesNotSerialize();
  await leg2b_keysFixTheSame24GiBHost();
  await leg3_distinctKeysStillParallel();
  await leg4_loneOverweightStillRuns();
  await leg5_falsyKeysStillExclude();
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  if (failures) {
    process.stdout.write(`\npool exclusive: ${failures} FAILED\n`);
    process.exit(1);
  }
  process.stdout.write('\nALL OK\n');
})().catch(e => { process.stderr.write(String(e.stack || e) + '\n'); process.exit(1); });
