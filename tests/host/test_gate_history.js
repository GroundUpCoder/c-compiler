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
// The stand-in holder must LOOK like a dispatcher (counter-pass 2 finding
// 3): liveness alone no longer suffices — a live pid whose command line is
// not a tests/run.js dispatcher is treated as PID reuse and stolen. The
// decoy carries 'tests/run.js' in its argv so ps shows it.
{
  const decoy = cp.spawn('node', ['-e', 'setInterval(() => {}, 1000)', 'decoy-arg', 'tests/run.js'],
    { stdio: 'ignore' });
  const lockPath = path.join(outDir, '.gate-lock');
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: decoy.pid, startedAt: new Date().toISOString(), argv: ['stand-in'] }));
  const sumBefore = statOrNull(path.join(outDir, 'summary.json'));
  const histBefore = listHistory();
  const r = gate(['todos']);
  check('leg 3: refused at exit 2 with the [gate-lock] marker',
    r.status === 2 && String(r.stderr).includes('[gate-lock]'),
    { status: r.status, stderr: String(r.stderr).slice(-300) });
  check('leg 3: the refusal names the holder pid', String(r.stderr).includes('pid ' + decoy.pid));
  check('leg 3: NO suite ran (no suite banner)', !String(r.stdout).includes('━━━'));
  check('leg 3: summary untouched', statOrNull(path.join(outDir, 'summary.json')) === sumBefore);
  check('leg 3: no new history entry', JSON.stringify(listHistory()) === JSON.stringify(histBefore));
  check('leg 3: the LIVE holder\'s lock survives the refused contender',
    fs.existsSync(lockPath));
  fs.rmSync(lockPath, { force: true });
  decoy.kill('SIGKILL');
}

// ---- leg 3a (#725 counter-pass 2, finding 1): ATOMIC PUBLICATION --------
// The property linkSync buys is directly observable: the lock file is NEVER
// readable without its holder JSON. The first race control (3b) proved only
// mutual exclusion — the reviewer reverted linkSync alone, at natural
// timing, and 3b stayed green because nothing forced a contender into the
// microseconds-wide empty window. So: a driver child performs 300 real
// acquire/release cycles while THIS process polls the lock as fast as it
// can; ONE observation of an existing-but-empty/unparseable lock is a RED.
// Against the openSync('wx')+write shape this fires at natural timing (the
// window is real even when short, and 300 windows give the observer
// thousands of chances); against link it is structurally impossible.
// Anti-vacuity guard: the observer must actually have SEEN the lock present
// many times, or it observed nothing and the pass would be manufactured by
// its own setup.
{
  const doneFile = path.join(priv, 'inv-done');
  const driver = cp.spawn(process.execPath, ['-e', `
    const { acquireGateLock } = require(${JSON.stringify(RUN)});
    process.setMaxListeners(0);
    for (let i = 0; i < 300; i++) { const rel = acquireGateLock(${JSON.stringify(outDir)}); rel(); }
    require('fs').writeFileSync(${JSON.stringify(doneFile)}, '1');
  `], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'] });
  let derr = '';
  driver.stderr.on('data', (d) => { derr += d; });
  const lockPath = path.join(outDir, '.gate-lock');
  let seenPresent = 0;
  let violations = 0;
  let firstViolation = null;
  const tEnd = Date.now() + 20000;
  while (!fs.existsSync(doneFile) && Date.now() < tEnd) {
    let txt = null;
    try { txt = fs.readFileSync(lockPath, 'utf8'); } catch { continue; } // absent — between cycles
    seenPresent++;
    let ok = false;
    try { ok = JSON.parse(txt) && typeof JSON.parse(txt).pid === 'number'; } catch { /* not JSON */ }
    if (!ok) { violations++; if (!firstViolation) firstViolation = JSON.stringify(txt.slice(0, 40)); }
  }
  check('leg 3a: driver completed its 300 acquire/release cycles',
    fs.existsSync(doneFile), derr.slice(-300));
  check('leg 3a: the observer really observed the lock (anti-vacuity: present >= 20 reads)',
    seenPresent >= 20, seenPresent);
  check('leg 3a: 🔴 the lock was NEVER observable without its holder JSON (atomic publication)',
    violations === 0, { violations, firstViolation, seenPresent });
  fs.rmSync(doneFile, { force: true });
}

// ---- leg 3b: CONCURRENT dispatchers — exactly one wins. SCOPE (narrowed ----
// ---- by counter-pass 2): this proves ordinary MUTUAL EXCLUSION under a  ----
// ---- natural race; it does NOT prove atomic publication — the reviewer  ----
// ---- reverted linkSync alone and this leg stayed green, because nothing ----
// ---- forces a contender into the microseconds-wide empty window. The    ----
// ---- atomic-publication property is leg 3a's, via the invariant         ----
// ---- observer, where it fails at NATURAL timing.                        ----
{
  // A tiny async driver child races the two dispatchers (this file is
  // linear/sync); each gate's exit code + stderr tail come back as JSON.
  const driver = cp.spawnSync(process.execPath, ['-e', `
    const cp = require('child_process');
    const go = () => new Promise((res) => {
      const c = cp.spawn('node', [${JSON.stringify(RUN)}, 'todos', '--out=' + ${JSON.stringify(outDir)}],
        { cwd: ${JSON.stringify(ROOT)} });
      let err = '';
      c.stderr.on('data', (d) => { err += d; });
      c.stdout.resume();   // drain — an unread pipe is the #725 defect itself
      c.on('exit', (code) => res({ code, err: err.slice(-1000) }));
    });
    Promise.all([go(), go()]).then(([a, b]) => console.log(JSON.stringify({ a, b })));
  `], { encoding: 'utf8', timeout: 120000 });
  let rr = null;
  try { rr = JSON.parse(driver.stdout); } catch { /* driver died */ }
  check('leg 3b: race driver completed', !!rr, { status: driver.status, err: String(driver.stderr).slice(-200) });
  const codes = rr ? [rr.a.code, rr.b.code].sort() : [];
  check('leg 3b: concurrent dispatchers — exactly one ran, one refused',
    JSON.stringify(codes) === JSON.stringify([0, 2]), rr && { a: rr.a.code, b: rr.b.code });
  const loser = rr && (rr.a.code === 2 ? rr.a : rr.b);
  check('leg 3b: the loser refused via the gate-lock, not some other exit-2 path',
    !!loser && loser.err.includes('[gate-lock]'), loser && loser.err.slice(-200));
  check('leg 3b: the winner released the lock', !fs.existsSync(path.join(outDir, '.gate-lock')));
  check('leg 3b: the winner\'s summary is valid', readSummary().results[0].status === 'pass');
}

// ---- leg 3c (#725 counter-pass): an UNPARSEABLE lock is stolen only ------
// ---- past the age grace, loudly — mid-acquisition is indistinguishable  ----
// ---- from abandoned garbage except by age, so staleness is PROVEN, not  ----
// ---- assumed. (Post-fix our own writers never produce an empty lock;    ----
// ---- this models a pre-fix leftover or a foreign truncated write.)      ----
{
  fs.writeFileSync(path.join(outDir, '.gate-lock'), '');   // fresh mtime, no JSON
  const r = gate(['todos']);
  check('leg 3c: gate completes over aged-out garbage (steals past the grace)',
    r.status === 0, { status: r.status, stderr: String(r.stderr).slice(-300) });
  // PARSE the reported age rather than pattern-matching the sentence: an
  // instant steal prints "age 0.0s > 2s grace" — a false statement that
  // still matches any shape-only regex. (Found by CPM4: removing the grace
  // branch left the original shape-only assert green. A wall-clock bound on
  // gate() is no better — the ~7s todos run satisfies >=2s vacuously.)
  const m = /\[gate-lock\] unparseable lock file \(age ([\d.]+)s > 2s grace\)/.exec(String(r.stderr));
  check('leg 3c: the steal is LOUD and names the age + grace', !!m, String(r.stderr).slice(0, 300));
  check('leg 3c: the REPORTED age proves the grace was waited out (>= 2s)',
    !!m && parseFloat(m[1]) >= 2, m && m[1]);
}

// ---- leg 3d (#725 counter-pass 2, finding 2): the pre-gate wait is ------
// ---- BOUNDED and gives up LOUDLY. A foreign writer refreshing an        ----
// ---- unparseable lock every 100ms used to hold the dispatcher forever,  ----
// ---- silently — the ticket's own defect (a gate that cannot explain     ----
// ---- itself) reintroduced by the grace logic. Now: exit 2 within the    ----
// ---- acquisition budget, naming what it waited on and for how long.     ----
{
  const lockPath = path.join(outDir, '.gate-lock');
  // The garbage lock must EXIST before the gate's first link attempt, and
  // the toucher must already be refreshing it — otherwise the gate simply
  // acquires an absent lock and runs (this leg's own first run went green
  // that way: a setup that guaranteed the wrong outcome).
  fs.writeFileSync(lockPath, '');
  const toucher = cp.spawn(process.execPath, ['-e', `
    const fs = require('fs');
    const t = setInterval(() => { try { fs.writeFileSync(${JSON.stringify(lockPath)}, ''); } catch {} }, 100);
    setTimeout(() => process.exit(0), 30000);
  `], { stdio: 'ignore' });
  cp.execSync('sleep 0.5');   // let the toucher boot before the gate starts
  const t0 = Date.now();
  const r = gate(['todos']);
  const elapsed = Date.now() - t0;
  toucher.kill('SIGKILL');
  fs.rmSync(lockPath, { force: true });
  check('leg 3d: a perpetually-refreshed garbage lock is REFUSED, not waited on forever',
    r.status === 2, { status: r.status, elapsed });
  check('leg 3d: …within the acquisition budget (bounded, not the harness timeout)',
    elapsed >= 15000 && elapsed < 30000, elapsed);
  check('leg 3d: the give-up is LOUD and names the wait',
    /\[gate-lock\] REFUSING: waited [\d.]+s to acquire/.test(String(r.stderr)) &&
      String(r.stderr).includes('gives up LOUDLY'),
    String(r.stderr).slice(-400));
  check('leg 3d: NO suite ran', !String(r.stdout).includes('━━━'));
}

// ---- leg 3e (#725 counter-pass 2, finding 3): PID reuse — a LIVE pid ----
// ---- that is not actually a dispatcher is stolen loudly, not refused    ----
// ---- until that unrelated process exits.                                ----
{
  const lockPath = path.join(outDir, '.gate-lock');
  // THIS process is alive and is not a tests/run.js dispatcher — exactly
  // the post-crash reuse shape.
  fs.writeFileSync(lockPath, JSON.stringify({
    pid: process.pid, startedAt: new Date().toISOString(), argv: ['stand-in'] }));
  const r = gate(['todos']);
  check('leg 3e: a live non-dispatcher pid is treated as PID reuse — the gate runs',
    r.status === 0, { status: r.status, stderr: String(r.stderr).slice(-300) });
  check('leg 3e: the steal is LOUD and names the mechanism',
    String(r.stderr).includes('PID reuse') && String(r.stderr).includes('pid ' + process.pid),
    String(r.stderr).slice(-300));
  check('leg 3e: lock released after the run', !fs.existsSync(lockPath));
}

// ---- leg 3f (#725 CP4 finding 2): identity DOMINATES age — a VERIFIED ----
// ---- live dispatcher is authoritative however old its record. The      ----
// ---- first landing checked the 6h age cap BEFORE the ps identity check, ----
// ---- so a legitimately long-running gate was robbed and the             ----
// ---- two-dispatchers-one-dir defect came back through the backstop.     ----
{
  const decoy = cp.spawn('node', ['-e', 'setInterval(() => {}, 1000)', 'decoy-arg', 'tests/run.js'],
    { stdio: 'ignore' });
  fs.writeFileSync(path.join(outDir, '.gate-lock'), JSON.stringify({
    pid: decoy.pid,
    startedAt: new Date(Date.now() - 7 * 3600 * 1000).toISOString(),   // 7h > the 6h cap
    argv: ['stand-in'] }));
  const r = gate(['todos']);
  check('leg 3f: an AGED but VERIFIED live dispatcher still REFUSES (never robbed by the age cap)',
    r.status === 2 && String(r.stderr).includes('[gate-lock] REFUSING'),
    { status: r.status, stderr: String(r.stderr).slice(-300) });
  check('leg 3f: no PID-reuse steal message fired', !String(r.stderr).includes('PID REUSE'));
  fs.rmSync(path.join(outDir, '.gate-lock'), { force: true });
  decoy.kill('SIGKILL');
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
