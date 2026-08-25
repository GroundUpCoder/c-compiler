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
// EXACT sample map, re-derived from the code and enforced by the seam
// (#725 CP3: the first version of this leg omitted hostStart from its map
// and passed only because the sticky last element papered over the
// off-by-one — the third vacuous control of this ticket; the seam now
// throws on exhaustion and reports under-consumption at exit, so a wrong
// map cannot pass): (1) preflight, (2) hostStart, (3) todos before,
// (4) todos after, (5) netsurf-patch before ← CRITICAL → truncate,
// (6) summary end sample.
{
  const arr = fakePath('midrun', [HEALTHY, HEALTHY, HEALTHY, HEALTHY, CRITICAL, HEALTHY]);
  const r = gate(['todos', 'netsurf-patch'], { CC_HOST_HEALTH_FAKE: arr });
  const out = String(r.stdout);
  check('leg 6: truncated gate exits nonzero (rule 5 stays red)', r.status === 1, r.status);
  check('leg 6: suite 1 ran and passed', out.includes('━━━ todos suite'));
  check('leg 6: suite 2 NEVER started (no banner)', !out.includes('━━━ netsurf-patch suite'));
  check('leg 6: the truncation is loud and names the reason',
    out.includes('[host-health] TRUNCATING') && /memory pressure level 4/.test(out));
  check('leg 6: the sample map is EXACT (no exhaustion, no under-consumption)',
    !String(r.stderr).includes('exhausted') && !String(r.stderr).includes('FAKE UNDER-CONSUMED'),
    String(r.stderr).slice(-200));
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

// ---- leg 6b (#725 CP3 finding 2): a critical AFTER-row sample stops -----
// the run — a degraded state the gate OBSERVED AND RECORDED must never be
// ignored just because the next row's fresh sample might read healthy.
// Map: (1) preflight H, (2) hostStart H, (3) todos before H, (4) todos
// after CRITICAL → truncate the remainder, (5) summary end sample.
{
  const arr = fakePath('afterrow', [HEALTHY, HEALTHY, HEALTHY, CRITICAL, HEALTHY]);
  const r = gate(['todos', 'netsurf-patch'], { CC_HOST_HEALTH_FAKE: arr });
  const out = String(r.stdout);
  check('leg 6b: after-row critical truncates — gate exits nonzero', r.status === 1, r.status);
  check('leg 6b: suite 2 never started', !out.includes('━━━ netsurf-patch suite'));
  check('leg 6b: exact map (seam quiet)', !String(r.stderr).includes('exhausted')
    && !String(r.stderr).includes('FAKE UNDER-CONSUMED'), String(r.stderr).slice(-200));
  const s = readSummary();
  const row1 = s.results.find((x) => x.suite === 'todos');
  const row2 = s.results.find((x) => x.suite === 'netsurf-patch');
  check('leg 6b: the COMPLETED row keeps its own honest result (it really ran)',
    !!row1 && row1.status === 'pass' && row1.host.after.pressure === 4, row1 && row1.status);
  check('leg 6b: the remainder is fail/host-degraded/DID NOT RUN',
    !!row2 && row2.status === 'fail' && row2.reason === 'host-degraded'
      && /^DID NOT RUN/.test(row2.note), row2);
  check('leg 6b: truncated.at names the first unrun suite',
    s.truncated && s.truncated.at === 'netsurf-patch', s.truncated);
}

// ---- leg 6c (#725 CP4 finding 1): the BATCHED python path — the sibling ----
// the native-path fix (and its controls) missed. All selected py categories
// run inside ONE batch, so "the next ordered token" can already have run.
{
  // (a) All-py selection, critical AFTER the batch: NOTHING remains unrun,
  // so there is NO truncation — the first landing declared one anyway
  // ("TRUNCATING at '<second category>'", truncated.at set, no failing row,
  // exit 0): a self-contradicting artifact. Map: (1) preflight, (2)
  // hostStart, (3) py-before, (4) py-after CRITICAL, (5) end.
  const r = gate(['disw', 'sourcemap'],
    { CC_HOST_HEALTH_FAKE: fakePath('pyafter-a', [HEALTHY, HEALTHY, HEALTHY, CRITICAL, HEALTHY]) });
  const out = String(r.stdout);
  const s = readSummary();
  check('leg 6c-a: all work ran — the gate exits by its results, with NO phantom truncation',
    r.status === 0 && !out.includes('TRUNCATING'), { status: r.status });
  check('leg 6c-a: summary declares NO truncation (artifact self-consistent)',
    s.truncated === undefined && !s.results.some((x) => x.reason === 'host-degraded'),
    s.truncated);
  check('leg 6c-a: the py batch row keeps its honest result',
    s.results.find((x) => /^py\[/.test(x.suite)).status === 'pass');
  check('leg 6c-a: exact map (seam quiet)', !String(r.stderr).includes('exhausted')
    && !String(r.stderr).includes('FAKE UNDER-CONSUMED'), String(r.stderr).slice(-200));
}
{
  // (b) py batch followed by a genuinely unrun NATIVE suite (kernel is the
  // only class that sorts after the py block; its runner NEVER spawns —
  // truncation fires first — and the heavy lock is scoped to a private
  // TMPDIR, the test_heavylock_gate isolation rule). The two CRITICAL
  // elements carry DISTINCT availGb so the truncation row proves WHICH
  // sample decided it: 0.4 = the py AFTER-sample (the fix), 0.3 = the next
  // before-sample (what a regressed after-check would consume instead —
  // and what keeps a regression from launching a real kernel suite here).
  const hlockDir = path.join(priv, 'hlock');
  fs.mkdirSync(hlockDir, { recursive: true });
  const C_AFTER = { ...CRITICAL, availGb: 0.4 };
  const C_NEXT = { ...CRITICAL, availGb: 0.3 };
  const r = gate(['disw', 'kernel'], {
    CC_HOST_HEALTH_FAKE: fakePath('pyafter-b', [HEALTHY, HEALTHY, HEALTHY, C_AFTER, C_NEXT]),
    TMPDIR: hlockDir, CC_HEAVY_LOCK_PID: '', CC_NO_HEAVY_LOCK: '',
  });
  const out = String(r.stdout);
  const s = readSummary();
  const kRow = s.results.find((x) => x.suite === 'kernel');
  check('leg 6c-b: py-after critical truncates the unrun kernel row — exit 1',
    r.status === 1 && out.includes("TRUNCATING at 'kernel'"), { status: r.status });
  check('leg 6c-b: the kernel suite NEVER started', !out.includes('━━━ kernel suite'));
  check('leg 6c-b: the truncated row is fail/host-degraded/DID NOT RUN',
    !!kRow && kRow.status === 'fail' && kRow.reason === 'host-degraded'
      && /^DID NOT RUN/.test(kRow.note), kRow);
  check('leg 6c-b: the decision came from the AFTER-sample (availGb 0.4, not the next before-sample\'s 0.3)',
    !!kRow && kRow.host.before.availGb === 0.4, kRow && kRow.host.before.availGb);
  check('leg 6c-b: truncated.at names the unrun suite', s.truncated && s.truncated.at === 'kernel', s.truncated);
  check('leg 6c-b: the py row keeps its honest pass',
    s.results.find((x) => /^py\[/.test(x.suite)).status === 'pass');
  check('leg 6c-b: exact map (seam quiet)', !String(r.stderr).includes('exhausted')
    && !String(r.stderr).includes('FAKE UNDER-CONSUMED'), String(r.stderr).slice(-200));
}

// ---- leg 8: the seam itself fails LOUDLY on misuse (both directions) ----
// The red control for the vacuous-control class: a control whose sample map
// is WRONG must go red, not pass off a sticky value.
{
  // Too FEW elements: the third sample() call (todos before) must throw.
  const r = gate(['todos'], { CC_HOST_HEALTH_FAKE: fakePath('short', [HEALTHY, HEALTHY]) });
  check('leg 8: an exhausted fake array crashes the gate loudly',
    r.status === 1 && String(r.stderr).includes('array exhausted after 2 sample(s)'),
    { status: r.status, tail: String(r.stderr).slice(-200) });
  check('leg 8: …naming what stickiness would have hidden',
    String(r.stderr).includes('sticky last element would have hidden this'));
  check('leg 8: the crashed gate released its lock', !fs.existsSync(path.join(outDir, '.gate-lock')));
  // Too MANY elements: unconsumed remainder is reported at exit.
  const r2 = gate(['todos'], { CC_HOST_HEALTH_FAKE: fakePath('long', Array(12).fill(HEALTHY)) });
  check('leg 8: an under-consumed fake array is reported at exit',
    r2.status === 0 && /FAKE UNDER-CONSUMED: 7 of 12 elements unused/.test(String(r2.stderr)),
    { status: r2.status, tail: String(r2.stderr).slice(-200) });
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
