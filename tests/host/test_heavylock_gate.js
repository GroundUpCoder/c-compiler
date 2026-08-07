'use strict';
// tests/host/test_heavylock_gate.js — the dispatcher's whole-gate heavy-lock
// reservation (#561), failure path exercised on every run (the
// test_tree_guard.js pattern: a guard whose failure path was never exercised
// is not a guard).
//
// THE DEFECT THIS PINS. The heavy suites used to take the host lock only when
// their own row started, and RUN_ORDER puts them last — so a gate could lose
// its heavy legs at exit 3 minutes in (2026-08-04: a gate lost its whole
// kernel leg to a sibling's bake), and `classify()` recorded that never-ran
// suite as a plain `fail`, indistinguishable from a genuine red. Now
// tests/run.js RESERVES the lock up front for the whole selected run whenever
// a heavy suite is in the set (refusal = exit 3 at start, nothing run, no
// summary), the runners join its reservation re-entrantly, and a contended
// row — the backstop — carries reason 'heavy-lock-contended'.
//
// Every leg redirects the lock scope through a private TMPDIR (heavy-lock.js
// derives its path from os.tmpdir()), so this file never touches the real
// host lock; the stand-in holder is THIS process's pid — alive by
// construction. The inherited CC_HEAVY_LOCK_PID / CC_NO_HEAVY_LOCK are
// stripped from every child env (the CLAUDE.md red-control rule: a leaked
// marker joins re-entrantly and you are testing nothing).
//
// Children are isolated from the enclosing gate's evidence: gate() always
// passes --out=<private dir> and asserts the canonical run-level record
// untouched after every child (#561 second finding — a nested dispatcher must
// never fabricate its parent's completion record; details at the isolation
// block below).
//
// Two legs pin the two halves against each other: leg 1 (RED) fails if the
// dispatcher stops reserving (the child would then run the kernel runner,
// which refuses at exit 3 → dispatcher exit 1 with a suite banner — not the
// asserted bannerless exit 3); leg 4 (GREEN) fails if the runner stops
// joining (it would contend against the gate's own reservation → contended
// row → dispatcher exit 1). Either regression is caught within seconds, and
// no leg can ever start real heavy work: whichever half is broken, the
// staged-or-reserved lock stops the kernel runner before any boot or bake.
//
// Run: node tests/host/test_heavylock_gate.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { mkdtempOwned } = require('../lib/harness-temp.js');
const { LOCK_PATH } = require('../lib/heavy-lock.js');

const ROOT = path.resolve(__dirname, '../..');
const RUN = path.join(ROOT, 'tests/run.js');
const RUN_SUMMARY = path.join(ROOT, 'build/test-run/summary.json');

let failures = 0;
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name); }
  else { console.log('  FAIL ' + name + (extra !== undefined ? '  ' + JSON.stringify(extra) : '')); failures++; }
}

const priv = mkdtempOwned('os-heavygate-');
const lockFile = path.join(priv, path.basename(LOCK_PATH));
const writeLock = (pid, name) => fs.writeFileSync(lockFile, JSON.stringify({
  pid, name, host: os.hostname(), startedAt: new Date().toISOString(),
  argv: ['stand-in'],
}));
const clearLock = () => fs.rmSync(lockFile, { force: true });

function childEnv() {
  const env = Object.assign({}, process.env, { TMPDIR: priv });
  delete env.CC_NO_HEAVY_LOCK;
  delete env.CC_HEAVY_LOCK_PID;
  return env;
}

// ---- canonical-record isolation (#561 second finding) ----
// Legs 3/4 run a REAL dispatcher to completion. Without isolation those
// children would write <ROOT>/build/test-run/summary.json — fabricating,
// mid-gate, the exact "the run completed" signal that leg 1 (and the fleet's
// judging rule: summary exists + fresh mtime + all rows pass ⇒ completed)
// relies on; a gate that died after the host suite would leave a green-looking
// one-row record behind. So gate() ALWAYS appends --out=<private dir> — a
// future leg cannot forget the isolation — and after EVERY child it asserts
// the canonical record is byte-and-mtime untouched, so a regression of --out
// itself fails loudly here. --out does not redirect the PER-SUITE artifacts
// (the suite runners write those), so gate() snapshots them too and restores
// bytes+mtime if a child moved one (leg 4's kernel child merges a 0-file run
// record into build/test-kernel/summary.json), asserting the restore. The
// crash-window residue (child wrote, this process died before restoring) is
// fail-safe: a filtered suite artifact fails rule 5's filter:null
// requirement, and the canonical run-level record was never touched at all.
const CANON = 'build/test-run/summary.json';           // must NEVER change
const SUITE_ARTIFACTS = ['build/test-kernel/summary.json',
                         'build/test-blockfs/summary.json',
                         'build/test-browser/summary.json'];
function snap(rel) {
  const p = path.join(ROOT, rel);
  try {
    const st = fs.statSync(p);
    return { bytes: fs.readFileSync(p), mtimeMs: st.mtimeMs, atimeMs: st.atimeMs };
  } catch { return null; }
}
function sameSnap(a, b) {
  if (a === null || b === null) return a === b;
  return a.bytes.equals(b.bytes) && Math.abs(a.mtimeMs - b.mtimeMs) < 5;
}
const snaps = new Map([CANON, ...SUITE_ARTIFACTS].map(rel => [rel, snap(rel)]));

let gateN = 0;
function gate(args, timeout) {
  const outDir = path.join(priv, 'out-' + (++gateN));
  const r = cp.spawnSync('node', [RUN, ...args, '--out=' + outDir],
    { cwd: ROOT, encoding: 'utf8', timeout: timeout || 120000, env: childEnv() });
  const label = args.join(' ');
  check(`gate() [${label}]: canonical run-level record untouched`,
    sameSnap(snap(CANON), snaps.get(CANON)));
  for (const rel of SUITE_ARTIFACTS) {
    const before = snaps.get(rel);
    if (sameSnap(snap(rel), before)) continue;
    const abs = path.join(ROOT, rel);
    if (before === null) fs.rmSync(abs, { force: true });
    else {
      fs.writeFileSync(abs, before.bytes);
      fs.utimesSync(abs, new Date(before.atimeMs), new Date(before.mtimeMs));
    }
    check(`gate() [${label}]: restored ${rel}`, sameSnap(snap(rel), before));
  }
  return { r, outDir };
}

const statOrNull = (p) => { try { const s = fs.statSync(p); return s.mtimeMs + ':' + s.size; } catch { return null; } };

// ---- leg 1 (the RED control): held lock + a heavy suite selected → the ----
// ---- gate refuses at exit 3 BEFORE any suite runs, and writes nothing  ----
writeLock(process.pid, 'stand-in holder');
{
  const before = statOrNull(RUN_SUMMARY);
  const { r } = gate(['kernel']);
  const err = String(r.stderr || '');
  check('leg 1: a contended gate exits 3 with the [heavy-lock] marker',
    r.status === 3 && err.includes('[heavy-lock]'), { status: r.status, stderr: err.slice(-500) });
  check('leg 1: the refusal NAMES the holder',
    err.includes('stand-in holder') && err.includes('pid ' + process.pid), err.slice(-300));
  check('leg 1: NO suite ran (no suite banner)', !String(r.stdout || '').includes('━━━'),
    String(r.stdout || '').slice(0, 300));
  check('leg 1: build/test-run/summary.json untouched (absent summary = did not finish)',
    statOrNull(RUN_SUMMARY) === before);
}

// ---- leg 2: --dry-run never contends — a plan is not a run ----
{
  const { r } = gate(['kernel', '--dry-run']);
  check('leg 2: --dry-run exits 0 under a held lock', r.status === 0,
    { status: r.status, stderr: String(r.stderr || '').slice(-300) });
  check('leg 2: the plan printed', String(r.stdout || '').includes('plan: kernel'));
}

// ---- leg 3: a light-only gate never contends — the reservation is scoped ----
// ---- to runs that will actually take the lock                            ----
{
  const { r } = gate(['netsurf-patch'], 180000);
  check('leg 3: a light-only gate runs to completion under a held lock',
    r.status === 0 && String(r.stdout || '').includes('━━━ netsurf-patch suite'),
    { status: r.status, tail: (String(r.stdout || '') + String(r.stderr || '')).slice(-500) });
}

// ---- leg 4 (the join proof): free lock → the gate reserves, the kernel ----
// ---- runner joins its reservation instead of contending against it     ----
// The 0-file filter keeps this cheap and boot-free: the kernel runner's
// prebake only fires for selected image consumers, so it parses, joins the
// lock, selects nothing, and exits 0. (Its 0-selected merge into
// build/test-kernel/summary.json is restored by gate() — see the isolation
// block above.) A runner that regressed to acquire would see the gate's own
// reservation as a foreign holder → exit 3 → the row goes
// 'heavy-lock-contended' → dispatcher exit 1, failing this leg.
clearLock();
{
  const { r, outDir } = gate(['kernel', '--filter=__no_such_test__'], 180000);
  const out = String(r.stdout || '');
  check('leg 4: gate over a free lock runs the kernel row to a pass',
    r.status === 0 && out.includes('━━━ kernel suite') && !out.includes('LOCK'),
    { status: r.status, tail: (out + String(r.stderr || '')).slice(-500) });
  check('leg 4: the gate released its reservation on exit', !fs.existsSync(lockFile));
  // The child's record landed in ITS OWN --out dir, not the canonical path —
  // and it is a real, judgeable record there.
  let child = null;
  try { child = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8')); } catch { /* absent */ }
  check('leg 4: the child wrote its summary into its --out dir',
    child !== null && JSON.stringify(child.suites) === '["kernel"]'
      && child.results.length === 1 && child.results[0].status === 'pass'
      && child.filter === '__no_such_test__',
    child && { suites: child.suites, filter: child.filter, rows: child.results });
}

clearLock();
console.log(failures === 0 ? '\nheavylock gate: PASS' : `\nheavylock gate: ${failures} FAILED`);
process.exitCode = failures === 0 ? 0 : 1;
