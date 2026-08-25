'use strict';
// #725 stage B: the dispatcher's host-health preflight and mid-run
// truncation — the parts of the gate that can STOP a run. Their failure
// mode is refusing healthy gates (which blocks every landing), so both
// directions are pinned: the guard fires on a degraded sample, and stays
// quiet on healthy/unmeasured ones.
//
// 🔴 PROXY LABEL (jku ruling on #725): every degraded state here is INJECTED
// via CC_HOST_HEALTH_FAKE — a synthetic sample, not a measurement of a real
// starved host. It proves the refusal/truncation PATHS execute correctly;
// the real-signal evidence lives in the dev log (the healthy-box sample
// sweeps and the bounded warn-tier experiment).
//
// Legs (nested dispatchers, private --out — the test_gate_history.js rule):
//   1. RED control: critical fake → exit 2, [host-health] marker, names the
//      instrument, states the CC_NO_HOST_HEALTH=1 override inline, writes a
//      refusal record (environmental classification, per-runId), NO
//      summary.json, no suite banner.
//   2. healthy fake → runs, exit 0, summary.hostHealth.level 'ok'.
//   3. REAL host, no fake → runs, exit 0 (one genuine quiet-direction
//      preflight per test run).
//   4. escape hatch: critical fake + CC_NO_HOST_HEALTH=1 → runs to
//      completion; summary records the disablement.
//   5. warn fake → runs, loud warning banner, exit 0.
//   6. mid-run truncation (array fake: healthy preflight + first row, then
//      critical): a two-suite gate runs suite 1 green, truncates suite 2 as
//      FAIL/'host-degraded'/DID NOT RUN, exits 1, never starts suite 2 —
//      and the summary+archive still exist (the run STARTED; contrast the
//      preflight refusal, which writes no summary at all).
//   7. unmeasured fake → runs (absence never refuses).
//
// Run: node tests/host/test_host_preflight.js
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

const priv = mkdtempOwned('os-hostpre-');
const outDir = path.join(priv, 'out');
const fakePath = (name, obj) => {
  const p = path.join(priv, name + '.json');
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
};

const HEALTHY = { measured: true, pressure: 1, memFreePct: 68, availGb: 5.6 };
const CRITICAL = { measured: true, pressure: 4, memFreePct: 4, availGb: 0.4 };
const WARN = { measured: true, pressure: 2, memFreePct: 40, availGb: 4.0 };

function gate(args, env) {
  return cp.spawnSync('node', [RUN, ...args, '--out=' + outDir],
    { cwd: ROOT, encoding: 'utf8', timeout: 180000, env: { ...process.env, ...env } });
}
const readSummary = () => JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'));
const statOrNull = (p) => { try { const s = fs.statSync(p); return s.mtimeMs + ':' + s.size; } catch { return null; } };

// ---- leg 1 (RED control): critical fake refuses before anything runs ----
{
  const sumBefore = statOrNull(path.join(outDir, 'summary.json'));   // null — no run yet
  const r = gate(['todos'], { CC_HOST_HEALTH_FAKE: fakePath('crit', CRITICAL) });
  const err = String(r.stderr);
  check('leg 1: refused at exit 2 with the [host-health] marker',
    r.status === 2 && err.includes('[host-health] REFUSING'), { status: r.status, tail: err.slice(-300) });
  check('leg 1: names the OS instrument', /memory pressure level 4/.test(err));
  check('leg 1: the override is documented IN the refusal, with its cost',
    err.includes('CC_NO_HOST_HEALTH=1') && err.includes('UNGUARDED'));
  check('leg 1: NO suite ran (no banner)', !String(r.stdout).includes('━━━'));
  check('leg 1: NO summary written (absent = did not finish)',
    statOrNull(path.join(outDir, 'summary.json')) === sumBefore);
  const recDir = path.join(outDir, 'refusals');
  const recs = fs.existsSync(recDir) ? fs.readdirSync(recDir) : [];
  check('leg 1: a per-runId refusal record exists', recs.length === 1, recs);
  const rec = recs.length ? JSON.parse(fs.readFileSync(path.join(recDir, recs[0]), 'utf8')) : null;
  check('leg 1: the record is classified environmental, with reasons + both samples',
    !!rec && /environmental/.test(rec.classification) && rec.reasons.length > 0
      && rec.sampleAfterRecovery && 'recovery' in rec, rec && Object.keys(rec));
  check('leg 1: the record names what recovery reaped (attempted BEFORE refusing)',
    !!rec && rec.recovery && Array.isArray(rec.recovery.procs));
}

// ---- leg 2: healthy fake runs normally ----------------------------------
{
  const r = gate(['todos'], { CC_HOST_HEALTH_FAKE: fakePath('ok', HEALTHY) });
  check('leg 2: healthy fake → gate runs, exit 0', r.status === 0,
    { status: r.status, tail: (String(r.stdout) + String(r.stderr)).slice(-300) });
  const s = readSummary();
  check('leg 2: summary records the preflight verdict', s.hostHealth && s.hostHealth.level === 'ok', s.hostHealth);
  check('leg 2: not truncated', s.truncated === undefined);
}

// ---- leg 3: the REAL host, no fake — the on-box quiet direction ---------
{
  const r = gate(['todos']);
  check('leg 3: real-host preflight stays quiet on this box (exit 0)', r.status === 0,
    { status: r.status, tail: String(r.stderr).slice(-300) });
  const s = readSummary();
  check('leg 3: real preflight verdict recorded', !!s.hostHealth && ['ok', 'warn'].includes(s.hostHealth.level), s.hostHealth);
}

// ---- leg 4: the escape hatch runs UNGUARDED but recorded ----------------
{
  const r = gate(['todos'], { CC_HOST_HEALTH_FAKE: fakePath('crit2', CRITICAL), CC_NO_HOST_HEALTH: '1' });
  check('leg 4: CC_NO_HOST_HEALTH=1 runs a "critical" host to completion', r.status === 0,
    { status: r.status, tail: String(r.stderr).slice(-200) });
  check('leg 4: the disablement is announced', String(r.stdout).includes('DISABLED by CC_NO_HOST_HEALTH=1'));
  const s = readSummary();
  check('leg 4: summary records the disablement', s.hostHealth && s.hostHealth.disabled === true, s.hostHealth);
  check('leg 4: samples still recorded (the fake rode through)',
    s.results[0].host && s.results[0].host.before.fake === true);
}

// ---- leg 5: warn tier proceeds loudly -----------------------------------
{
  const r = gate(['todos'], { CC_HOST_HEALTH_FAKE: fakePath('warn', WARN) });
  check('leg 5: warn fake → gate still runs, exit 0', r.status === 0, r.status);
  check('leg 5: the warning is loud and names the tier',
    String(r.stdout).includes('[host-health] WARNING') && /warn tier/.test(String(r.stdout)),
    String(r.stdout).split('\n').filter(l => l.includes('host-health')).join(' | '));
  const s = readSummary();
  check('leg 5: summary records the warn verdict', s.hostHealth && s.hostHealth.level === 'warn', s.hostHealth);
}

// ---- leg 6: mid-run truncation — deterministic via the array fake -------
// Call order in the dispatcher: preflight(0), row-1 before(1), row-1
// after(2), row-2 before(3) ← the first degraded sample. Suites: todos runs
// first in RUN_ORDER, netsurf-patch second.
{
  const arr = fakePath('midrun', [HEALTHY, HEALTHY, HEALTHY, CRITICAL]);
  const r = gate(['todos', 'netsurf-patch'], { CC_HOST_HEALTH_FAKE: arr });
  const out = String(r.stdout);
  check('leg 6: truncated gate exits nonzero (rule 5 stays red)', r.status === 1, r.status);
  check('leg 6: suite 1 ran and passed', out.includes('━━━ todos suite'));
  check('leg 6: suite 2 NEVER started (no banner)', !out.includes('━━━ netsurf-patch suite'));
  check('leg 6: the truncation is loud and names the reason',
    out.includes('[host-health] TRUNCATING') && /memory pressure level 4/.test(out));
  const s = readSummary();
  const row1 = s.results.find((x) => x.suite === 'todos');
  const row2 = s.results.find((x) => x.suite === 'netsurf-patch');
  check('leg 6: 🔴 the truncated row is literally fail/host-degraded/DID NOT RUN',
    !!row2 && row2.status === 'fail' && row2.reason === 'host-degraded'
      && /^DID NOT RUN/.test(row2.note), row2);
  check('leg 6: the row that ran keeps its own honest pass', !!row1 && row1.status === 'pass');
  check('leg 6: summary.truncated names the stop point and reasons',
    s.truncated && s.truncated.at === 'netsurf-patch' && s.truncated.reasons.length > 0, s.truncated);
  check('leg 6: the run STARTED, so it IS summarized + archived (contrast the preflight refusal)',
    fs.existsSync(path.join(outDir, 'history', s.runId, 'summary.json')));
  check('leg 6: HOST tag on the verdict line', out.includes('HOST') && out.includes('host degraded'));
}

// ---- leg 7: unmeasured never refuses ------------------------------------
{
  const r = gate(['todos'], { CC_HOST_HEALTH_FAKE: fakePath('unm', { measured: false }) });
  check('leg 7: unmeasured host → gate runs (absence never refuses)', r.status === 0, r.status);
  check('leg 7: the unmeasured state is said out loud',
    String(r.stdout).includes('instruments unmeasured'));
}

fs.rmSync(priv, { recursive: true, force: true });
console.log(failures === 0 ? 'PASS' : 'FAIL (' + failures + ')');
process.exit(failures === 0 ? 0 : 1);
