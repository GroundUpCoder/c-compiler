'use strict';
// #725: the dispatcher's evidence-retention layer — run identity, per-suite
// transcript tee, the append-only history archive, the artifact-dir gate
// lock, and the host-sample labelling wiring.
//
// THE DEFECT CLASS THIS PINS. On 2026-08-25 a pre-deploy full sweep went red
// and the failing kernel summary was merged over by the diagnostic reruns
// that followed — the red's own record survived nowhere but terminal scroll.
// Separately, the ticket's launchd double-submit overwrote its first run's
// paths. So: every dispatcher run archives its evidence under an immutable
// runId BEFORE any retry can touch it, and two dispatchers cannot write one
// artifact dir concurrently.
//
// Legs (nested dispatchers always run --out=<private dir> — the
// test_heavylock_gate.js isolation rule: a child must never fabricate or
// disturb the canonical build/test-run record):
//   1. a real run records runId + host telemetry and archives
//      history/<runId>/{summary.json, logs/<suite>.log}; the gate lock is
//      released on exit.
//   2. a SECOND run into the same dir gets its own runId and leaves run 1's
//      archive byte-identical — the retry-cannot-destroy-evidence property.
//   3. RED control: a LIVE .gate-lock refuses at exit 2 with the [gate-lock]
//      marker, runs nothing, writes nothing (summary untouched, no new
//      history) — the launchd double-submit case.
//   4. a DEAD holder's lock is stolen (a crashed gate must not brick the
//      artifact dir).
//   5. history prunes to HISTORY_KEEP, dropping the OLDEST runs only.
//   6. attachHostSamples wiring (in-process, via CC_HOST_HEALTH_FAKE): a
//      FAILING row under a degraded fake gets hostSuspect WITH ITS STATUS
//      UNTOUCHED; a passing row under the same fake gets NO label; 🔴 the
//      never-a-pass property — the label must never soften a red (jku
//      condition 3 on #725).
//
// Run: node tests/host/test_gate_history.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { mkdtempOwned } = require('../lib/harness-temp.js');

const ROOT = path.resolve(__dirname, '../..');
const RUN = path.join(ROOT, 'tests/run.js');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); failures++; }
}

const priv = mkdtempOwned('os-gatehist-');
const outDir = path.join(priv, 'out');

// `todos` is the cheapest real suite (~7s); every leg that needs a full
// dispatcher run uses it.
function gate(args, env) {
  return cp.spawnSync('node', [RUN, ...args, '--out=' + outDir],
    { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: { ...process.env, ...env } });
}
const readSummary = () => JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'));
const listHistory = () => {
  try { return fs.readdirSync(path.join(outDir, 'history')).sort(); } catch { return []; }
};
const statOrNull = (p) => { try { const s = fs.statSync(p); return s.mtimeMs + ':' + s.size; } catch { return null; } };

// ---- leg 1: a run records identity + telemetry and archives itself ------
let runId1 = null;
{
  const r = gate(['todos']);
  check('leg 1: todos gate passes', r.status === 0, { status: r.status, tail: (r.stdout + r.stderr).slice(-400) });
  const s = readSummary();
  runId1 = s.runId;
  check('leg 1: summary carries a runId', /^\d{8}-\d{6}-\d+$/.test(s.runId || ''), s.runId);
  check('leg 1: summary carries boundary host samples',
    !!(s.host && s.host.start && s.host.end && s.host.hostname === os.hostname()),
    s.host && { hostname: s.host.hostname });
  check('leg 1: per-row host samples recorded',
    !!(s.results[0].host && s.results[0].host.before && s.results[0].host.after));
  check('leg 1: no hostSuspect on a passing row', !('hostSuspect' in s.results[0]));
  const hist = path.join(outDir, 'history', s.runId);
  check('leg 1: history/<runId>/summary.json archived', fs.existsSync(path.join(hist, 'summary.json')));
  let tee = '';
  try { tee = fs.readFileSync(path.join(hist, 'logs', 'todos.log'), 'utf8'); } catch {}
  check('leg 1: the suite transcript was tee\'d into history',
    tee.includes('tests/todos/run.js') && tee.length > 100, tee.slice(0, 80));
  check('leg 1: the gate lock was released on exit',
    !fs.existsSync(path.join(outDir, '.gate-lock')));
}

// ---- leg 2: a retry cannot destroy the previous run's archive -----------
{
  const before = fs.readFileSync(path.join(outDir, 'history', runId1, 'summary.json'));
  const r = gate(['todos']);
  check('leg 2: second run into the same dir passes', r.status === 0);
  const s = readSummary();
  check('leg 2: distinct runId', s.runId && s.runId !== runId1, { first: runId1, second: s.runId });
  check('leg 2: both runs present in history', listHistory().length === 2, listHistory());
  const after = fs.readFileSync(path.join(outDir, 'history', runId1, 'summary.json'));
  check('leg 2: run 1\'s archived summary is byte-identical after the retry', before.equals(after));
}

// ---- leg 3 (RED control): a live gate-lock refuses, runs nothing --------
{
  const lockPath = path.join(outDir, '.gate-lock');
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid, startedAt: new Date().toISOString(), argv: ['stand-in'] }));
  const sumBefore = statOrNull(path.join(outDir, 'summary.json'));
  const histBefore = listHistory();
  const r = gate(['todos']);
  check('leg 3: refused at exit 2 with the [gate-lock] marker',
    r.status === 2 && String(r.stderr).includes('[gate-lock]'),
    { status: r.status, stderr: String(r.stderr).slice(-300) });
  check('leg 3: the refusal names the holder pid', String(r.stderr).includes('pid ' + process.pid));
  check('leg 3: NO suite ran (no suite banner)', !String(r.stdout).includes('━━━'));
  check('leg 3: summary untouched', statOrNull(path.join(outDir, 'summary.json')) === sumBefore);
  check('leg 3: no new history entry', JSON.stringify(listHistory()) === JSON.stringify(histBefore));
  check('leg 3: the LIVE holder\'s lock survives the refused contender',
    fs.existsSync(lockPath));
  fs.rmSync(lockPath, { force: true });
}

// ---- leg 4: a dead holder's lock is stolen ------------------------------
{
  // A just-exited child's pid: dead by construction, far too recent to be
  // recycled by an unrelated process.
  const dead = cp.spawnSync(process.execPath, ['-e', '']).pid
    || cp.spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout.trim();
  const deadPid = typeof dead === 'number' ? dead : +dead;
  fs.writeFileSync(path.join(outDir, '.gate-lock'), JSON.stringify({
    pid: deadPid, startedAt: new Date().toISOString(), argv: ['dead-holder'] }));
  const r = gate(['todos']);
  check('leg 4: a dead holder\'s lock is stolen and the gate runs', r.status === 0,
    { status: r.status, stderr: String(r.stderr).slice(-300) });
  check('leg 4: lock released again', !fs.existsSync(path.join(outDir, '.gate-lock')));
}

// ---- leg 5: history prunes to HISTORY_KEEP, oldest first ----------------
{
  const { HISTORY_KEEP } = require('../run.js');
  const histRoot = path.join(outDir, 'history');
  // Seed enough OLD fake runs to overflow the cap (names sort before any
  // real 2026 runId).
  const seeded = [];
  for (let i = 0; i < HISTORY_KEEP + 5; i++) {
    const name = `20200101-${String(100000 + i)}-1`;
    fs.mkdirSync(path.join(histRoot, name), { recursive: true });
    seeded.push(name);
  }
  const r = gate(['todos']);
  check('leg 5: gate still passes over an overflowing history', r.status === 0);
  const runs = listHistory();
  check(`leg 5: pruned to HISTORY_KEEP (${HISTORY_KEEP})`, runs.length === HISTORY_KEEP, runs.length);
  check('leg 5: the newest run survived pruning', runs.includes(readSummary().runId));
  check('leg 5: the OLDEST seeds are what got dropped', !runs.includes(seeded[0]) && !runs.includes(seeded[1]));
}

// ---- leg 6: a git failure refuses the diff plan (#725) ------------------
// Before: a bad ref made git fail, stderr was DISCARDED, changedFiles
// coalesced to "no changes", and `--diff <bad-ref>` exited 0 having planned
// an empty run — a silent green. Now: exit 2, git's own stderr included.
{
  const r = gate(['--diff', 'no-such-ref-xyz-725', '--dry-run']);
  check('leg 6: --diff on a bad ref refuses at exit 2', r.status === 2,
    { status: r.status, stderr: String(r.stderr).slice(-300) });
  check('leg 6: the refusal carries git\'s own stderr',
    /unknown revision|bad revision|ambiguous argument/.test(String(r.stderr)), String(r.stderr).slice(-200));
  check('leg 6: …and names the empty-green hazard',
    String(r.stderr).includes('refusing rather than planning an empty'));
  const ok = gate(['--diff', 'HEAD', '--dry-run']);
  check('leg 6: a valid ref still plans normally', ok.status === 0,
    { status: ok.status, stderr: String(ok.stderr).slice(-200) });
}

// ---- leg 7: attachHostSamples wiring (never-a-pass) ---------------------
{
  const { attachHostSamples } = require('../run.js');
  const fakeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gatehist-fake-'));
  const fakePath = path.join(fakeDir, 's.json');
  fs.writeFileSync(fakePath, JSON.stringify({
    measured: true, pressure: 4, memFreePct: 4, availGb: 0.4 }));
  process.env.CC_HOST_HEALTH_FAKE = fakePath;
  try {
    const failRow = attachHostSamples({ suite: 'x', status: 'fail', exit: 1 },
      { measured: true, pressure: 4, memFreePct: 4 });
    check('leg 7: a failing row under pressure 4 gets hostSuspect',
      !!failRow.hostSuspect && failRow.hostSuspect.why.length > 0, failRow.hostSuspect);
    check('leg 7: 🔴 the label NEVER touches status — the row is still literally \'fail\'',
      failRow.status === 'fail' && failRow.exit === 1, failRow);
    const passRow = attachHostSamples({ suite: 'x', status: 'pass' },
      { measured: true, pressure: 4, memFreePct: 4 });
    check('leg 7: a PASSING row under the same degradation gets NO label',
      !('hostSuspect' in passRow) && passRow.status === 'pass');
    const healthyFail = attachHostSamples({ suite: 'x', status: 'fail' },
      { measured: true, pressure: 1, memFreePct: 68 });
    // after-sample is the fake (pressure 4), so this still labels — assert
    // the samples themselves were recorded either way.
    check('leg 7: boundary samples recorded on every row', !!healthyFail.host.before && !!healthyFail.host.after);
  } finally {
    delete process.env.CC_HOST_HEALTH_FAKE;
    fs.rmSync(fakeDir, { recursive: true, force: true });
  }
}

fs.rmSync(priv, { recursive: true, force: true });
console.log(failures === 0 ? 'PASS' : 'FAIL (' + failures + ')');
process.exit(failures === 0 ? 0 : 1);
