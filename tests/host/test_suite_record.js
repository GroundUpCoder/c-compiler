'use strict';
// The suite-runner's RUN RECORD contract (todos/0339).
//
// The full browser sweep exceeds a single tool call, so it is always run as two
// `--filter` halves. Before this contract existed, both halves wrote
// `summary.json` and the second DELETED the first: a complete 40-file sweep and
// a lane that ran twenty files by mistake left byte-identical artifacts, both
// saying `pass`. Reviewing the artifact could not tell them apart.
//
// What is pinned here, on a 4-file synthetic suite (real child processes, real
// summary.json — the engine is exercised, not mocked):
//   1. a run records its own scope: filter + total/selected/executed
//   2. a second filtered run MERGES rather than clobbers; the record then
//      accounts for all 4 files and names both contributing runs
//   3. a single half is VISIBLY partial (recorded < total)
//   4. a carried result is tagged and stamped with the run that measured it —
//      merging must never make a stale result look fresh
//   5. --resume never resumes off a CARRIED result (that would let a file that
//      passed days ago be skipped by a "full" run and still report green — the
//      same stale-scope failure, reintroduced through the back door)
//   6. an unfiltered run carries nothing, so `runs` collapses back to one entry
//
//   node tests/host/test_suite_record.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runSuite } = require('../lib/suite-runner.js');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n         ' + (e.message || e)); failures++; }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-suite-record-'));
const dir = path.join(root, 'suite');
const artifactDir = path.join(root, 'artifacts');
fs.mkdirSync(dir, { recursive: true });

const NAMES = ['t1.js', 't2.js', 't3.js', 't4.js'];
for (const n of NAMES) fs.writeFileSync(path.join(dir, n), 'process.exit(0);\n');
const entries = NAMES.map(file => ({ file }));

const summaryPath = path.join(artifactDir, 'summary.json');
const readSummary = () => JSON.parse(fs.readFileSync(summaryPath, 'utf-8'));

function run(extra) {
  return runSuite(entries, Object.assign({
    name: 'record fixture', dir, artifactDir, jobs: 1, timeoutMs: 30000,
    filter: null, failFast: false, resume: false,
  }, extra));
}

(async () => {
  // ---- 1 + 3: half one records its scope, and is visibly PARTIAL ----
  await run({ filter: 't1,t2' });
  const half1 = readSummary();

  check('a filtered run records the filter verbatim', () => {
    assert.strictEqual(half1.filter, 't1,t2');
  });
  check('half one records 2 of 4 selected and executed', () => {
    assert.strictEqual(half1.files.total, 4);
    assert.strictEqual(half1.files.selected, 2);
    assert.strictEqual(half1.files.executed, 2);
  });
  check('a single half is VISIBLY partial (recorded < total)', () => {
    assert.strictEqual(half1.files.recorded, 2);
    assert.ok(half1.files.recorded < half1.files.total,
      'a half run must not look like a full run');
  });
  check('half one names exactly one contributing run', () => {
    assert.strictEqual(half1.runs.length, 1);
    assert.strictEqual(half1.runs[0].filter, 't1,t2');
    assert.strictEqual(half1.runs[0].executed, 2);
  });

  // ---- 2 + 4: half two MERGES; the record accounts for all four ----
  await run({ filter: 't3,t4' });
  const merged = readSummary();

  check('half two does not delete half one', () => {
    assert.strictEqual(merged.results.length, 4);
    assert.deepStrictEqual(merged.results.map(r => r.file).sort(), NAMES.slice().sort());
  });
  check('the merged record accounts for the whole suite', () => {
    assert.strictEqual(merged.files.total, 4);
    assert.strictEqual(merged.files.selected, 2);
    assert.strictEqual(merged.files.executed, 2);
    assert.strictEqual(merged.files.carried, 2);
    assert.strictEqual(merged.files.recorded, 4);
  });
  check('carried results are TAGGED, not silently promoted to fresh', () => {
    const carried = merged.results.filter(r => r.carried);
    assert.deepStrictEqual(carried.map(r => r.file).sort(), ['t1.js', 't2.js']);
    for (const r of carried) {
      assert.strictEqual(r.carriedFrom, half1.startedAt,
        'a carried result must name the run that measured it');
    }
    for (const r of merged.results.filter(r => !r.carried)) {
      assert.ok(['t3.js', 't4.js'].includes(r.file));
    }
  });
  check('both contributing runs are named, with their filters and counts', () => {
    assert.strictEqual(merged.runs.length, 2);
    assert.deepStrictEqual(merged.runs.map(r => r.filter), ['t1,t2', 't3,t4']);
    assert.deepStrictEqual(merged.runs.map(r => r.executed), [2, 2]);
    assert.strictEqual(merged.runs[0].startedAt, half1.startedAt);
  });

  // ---- 5: --resume must not resume off a carried result ----
  await run({ resume: true });
  const resumedRun = readSummary();

  check('--resume re-runs CARRIED files and skips only the last run\'s own passes', () => {
    // t3/t4 were run 2's own results → legitimately resumable.
    // t1/t2 were merged in from run 1 → must be re-executed, not trusted.
    assert.strictEqual(resumedRun.files.selected, 4);
    assert.strictEqual(resumedRun.files.resumed, 2);
    assert.strictEqual(resumedRun.files.executed, 2);
    const executedNow = resumedRun.results.filter(r => !r.carried && !r.resumed).map(r => r.file);
    assert.deepStrictEqual(executedNow.sort(), ['t1.js', 't2.js']);
  });
  check('an unfiltered run records filter: null and covers the suite', () => {
    assert.strictEqual(resumedRun.filter, null);
    assert.strictEqual(resumedRun.files.carried, 0);
    assert.strictEqual(resumedRun.files.recorded, 4);
  });

  // ---- 6: nothing carried → the runs list collapses to this run alone ----
  await run({});
  const full = readSummary();

  check('a full unfiltered run carries nothing and names one run', () => {
    assert.strictEqual(full.files.executed, 4);
    assert.strictEqual(full.files.carried, 0);
    assert.strictEqual(full.files.recorded, 4);
    assert.strictEqual(full.runs.length, 1);
    assert.strictEqual(full.runs[0].filter, null);
  });
  check('a full run leaves no carried tags behind', () => {
    assert.strictEqual(full.results.filter(r => r.carried).length, 0);
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nsuite-record: all checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
