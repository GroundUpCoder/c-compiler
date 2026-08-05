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
// And the RESUME FRESHNESS contract (ticket #455), pinned on the same fixture:
//   7. a member whose own SOURCE is newer than its passing log is EXECUTED, not
//      resumed — the predicate used to be status-only, so "fix the test, re-run
//      with --resume to confirm" skipped the file that had just been fixed and
//      printed green
//   8. an untouched member still resumes — the regression that matters, since
//      resume's whole purpose is the 21-resumed sweep and 152-resumed kernel run
//   9. a member with no per-file log is executed: there is no evidence of that
//      pass in this artifact dir, whatever the status field says
//
// And the RED-LOG PRESERVATION contract (ticket #456), same fixture:
//  10. a re-run over a recorded failure moves the failing log aside under a
//      monotonic .redN suffix instead of truncating it — the solo re-run that
//      diagnoses a red must not be the thing that destroys its evidence;
//      green logs are overwritten freely
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

  // ---- 7 + 8 + 9: resume freshness (#455) ----
  //
  // All four files have just executed, so every source/log pair exists. Stamp
  // them to EXACT times rather than relying on wall-clock ordering: the whole
  // predicate is an mtime comparison, so a test that let the clock decide the
  // inputs would be measuring the clock. Nothing is stamped into the future —
  // a run that re-executes a file writes its log at the real `now`, and that
  // must land AFTER the stamps, or case 8 would inherit case 7's staleness.
  const srcPath = f => path.join(dir, f);
  const logPath = f => path.join(artifactDir, f + '.log');
  const setMtime = (p, ms) => fs.utimesSync(p, ms / 1000, ms / 1000);
  const T0 = Date.now() - 60_000;
  for (const n of NAMES) { setMtime(srcPath(n), T0); setMtime(logPath(n), T0 + 30_000); }

  // 7: t2's source is edited after its pass. Its status is still `pass`; the
  // pass is stale, and the old predicate would have skipped it anyway.
  fs.writeFileSync(srcPath('t2.js'), 'process.exit(0); // edited after the pass\n');
  setMtime(srcPath('t2.js'), T0 + 45_000);
  await run({ resume: true });
  const edited = readSummary();

  check('a member edited since its passing log is EXECUTED, not resumed', () => {
    const executedNow = edited.results.filter(r => !r.carried && !r.resumed).map(r => r.file);
    assert.deepStrictEqual(executedNow, ['t2.js'],
      'the edited file must run; skipping it is how a fix-then-confirm run reports green having proved nothing');
    assert.strictEqual(edited.files.executed, 1);
  });
  check('the three untouched members still resume in that same run', () => {
    const resumedNow = edited.results.filter(r => r.resumed).map(r => r.file).sort();
    assert.deepStrictEqual(resumedNow, ['t1.js', 't3.js', 't4.js']);
    assert.strictEqual(edited.files.resumed, 3);
    assert.ok(!resumedNow.includes('t2.js'), 't2.js must not be counted as resumed');
  });

  // 8: nothing touched since — resume must still skip everything. This is the
  // regression guard: the fix must not degrade --resume into a no-op.
  await run({ resume: true });
  const untouched = readSummary();

  check('with nothing edited, every member resumes (resume is not a no-op)', () => {
    assert.strictEqual(untouched.files.resumed, 4);
    assert.strictEqual(untouched.files.executed, 0);
    assert.deepStrictEqual(untouched.results.filter(r => r.resumed).map(r => r.file).sort(),
      NAMES.slice().sort());
  });

  // 9: no log = no evidence of that pass in THIS artifact dir, whatever the
  // recorded status says.
  fs.rmSync(logPath('t3.js'));
  await run({ resume: true });
  const noLog = readSummary();

  check('a member whose per-file log is gone is executed, not resumed', () => {
    const executedNow = noLog.results.filter(r => !r.carried && !r.resumed).map(r => r.file);
    assert.deepStrictEqual(executedNow, ['t3.js']);
    assert.strictEqual(noLog.files.resumed, 3);
  });

  // ---- 10: a re-run must not destroy failure evidence (ticket #456) ----
  //
  // The original #456 red survived only in a dispatcher probe log: the solo
  // re-run that anyone reaches for to diagnose a red truncates the failing
  // log into a PASS. Pinned: the failing log is moved aside under .redN
  // before the re-run opens it, greens are overwritten freely, and the
  // counter is monotonic across repeated red→green cycles.
  fs.writeFileSync(srcPath('t2.js'), 'console.error("RED-EVIDENCE-42"); process.exit(1);\n');
  await run({});
  const redRun = readSummary();
  check('the fixture red is a real red', () => {
    assert.strictEqual(redRun.results.find(r => r.file === 't2.js').status, 'fail');
    assert.ok(fs.readFileSync(logPath('t2.js'), 'utf-8').includes('RED-EVIDENCE-42'));
  });

  fs.writeFileSync(srcPath('t2.js'), 'process.exit(0); // fixed\n');
  await run({});
  check('the diagnosing re-run preserves the red log under .red1', () => {
    const red1 = logPath('t2.js').replace(/\.log$/, '.red1.log');
    assert.ok(fs.existsSync(red1), 'the failing log must survive the re-run');
    assert.ok(fs.readFileSync(red1, 'utf-8').includes('RED-EVIDENCE-42'),
      'the archived log must be the red evidence, not a copy of the new pass');
    assert.ok(!fs.readFileSync(logPath('t2.js'), 'utf-8').includes('RED-EVIDENCE-42'),
      'the live log must be the fresh run');
  });
  check('a passing member\'s log is overwritten freely (no archive)', () => {
    assert.ok(!fs.existsSync(logPath('t1.js').replace(/\.log$/, '.red1.log')));
  });

  // A second red→green cycle: the red overwrites the GREEN log freely (no
  // archive of a pass), and the next green archives to .red2, not over .red1.
  fs.writeFileSync(srcPath('t2.js'), 'console.error("RED-EVIDENCE-43"); process.exit(1);\n');
  await run({});
  fs.writeFileSync(srcPath('t2.js'), 'process.exit(0); // fixed again\n');
  await run({});
  check('a second cycle archives to .red2 and leaves .red1 intact', () => {
    const red1 = logPath('t2.js').replace(/\.log$/, '.red1.log');
    const red2 = logPath('t2.js').replace(/\.log$/, '.red2.log');
    assert.ok(fs.existsSync(red2), 'the second red must be preserved too');
    assert.ok(fs.readFileSync(red2, 'utf-8').includes('RED-EVIDENCE-43'));
    assert.ok(fs.readFileSync(red1, 'utf-8').includes('RED-EVIDENCE-42'),
      'the first archive must not be clobbered by the second');
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(failures ? `\n${failures} check(s) FAILED` : '\nsuite-record: all checks passed');
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
