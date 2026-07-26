'use strict';
// tests/lib/harness-leaks.js — the harness's STARTUP pre-flight: make leaked
// resources from earlier runs VISIBLE, then reap the ones that are provably
// abandoned, before a suite starts.
//
// WHY THIS EXISTS. Two leaks, one family: a test run that dies abruptly leaves
// its resources behind, and both of them then FABRICATE FALSE TEST SIGNAL.
//
//   os-* fixture dirs in $TMPDIR  (tests/kernel/lib/drive.js freshImage)
//       144-197 MB each. 779 abandoned dirs = 49 GB = a 100%-full disk, which
//       presented as test TIMEOUTS and spurious failures. ENOSPC impersonating
//       a product regression.
//   orphaned serve.js listeners   (tests/browser/lib/os-harness.mjs startServer)
//       70 of them with PPID 1 in one round, squatting the sweep's FIXED
//       per-file ports. serve.js's tryListen() walks to port+1 on EADDRINUSE,
//       so the NEW server quietly moves aside while the test keeps polling the
//       fixed port and talks to the STALE one. Spurious reds with nothing to do
//       with the code under test. (serve.js --strict-port now refuses to do the
//       silent walk when the harness is the caller.)
//   os/os-system.img.tmp-<pid>    (tools/mkimage.js atomic-rename temp)
//       111 MB each, in-tree — and matched by .gitignore, so `git status` never
//       showed them. 409 MB of these had been accumulating since Jul 17 and
//       nobody saw it. THAT is why these went unnoticed: the leak was silent.
//       Everything this module finds gets PRINTED, whether or not it is reaped.
//
// THE THREE DEATHS, AND WHAT COVERS EACH. Handlers are not enough — a SIGKILL
// runs none, by definition. So the design is prevention where it can work, plus
// a retroactive sweep that needs nothing to have run at death time:
//
//   clean exit .............. harness-temp.js process-lifetime hooks; the test's
//                             own server.kill(); serve.js's parent watchdog.
//   per-file TIMEOUT ........ suite-runner already SIGKILLs the whole process
//                             GROUP (the test file is detached => group leader),
//                             which takes serve.js + Chromium with it. The temp
//                             DIR survives that (nothing runs) -> reaped here.
//   RUNNER killed from outside (the 600s call-ceiling case, and the one that
//   actually produced the 70 orphans) ... the runner's SIGINT/SIGTERM handler
//                             never runs on SIGKILL, and its children are in a
//                             DIFFERENT process group (detached), so killing the
//                             runner's group never reaches them. Two things
//                             cover it: tests/lib/parent-watch.js (preloaded into
//                             every spawned test file; notices its ppid change
//                             and SIGKILLs its own group) and, for anything that
//                             still slips through or predates the fix, this
//                             reaper on the NEXT run.
//
// SAFETY AGAINST A CONCURRENT RUN. Reaping is never "looks old" — it is
// "the owning process is DEAD":
//   - temp dirs carry their owner's pid in the name (harness-temp.mkdtempOwned);
//   - a process is reaped only when its PPID is 1, i.e. the OS itself has
//     already declared it parentless.
// A live hand-run `node tests/kernel/test_wm.js` (which takes NO heavy lock) has
// a living pid and a living parent, so nothing of its is touched. On top of
// that, callers run preflight() AFTER acquireHeavyLock(), so no OTHER heavy
// suite can even be mid-flight: the lock's fail-fast (exit 3) happens first and
// this code never executes. The lock itself is untouched by this module.
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pidAlive } = require('./heavy-lock.js');

const ROOT = path.resolve(__dirname, '../..');

// `<prefix><pid>-<6 mkdtemp chars>` — see harness-temp.mkdtempOwned.
const TEMP_DIR_RE = /^os-.*-(\d+)-[A-Za-z0-9]{6}$/;
// Dirs from BEFORE the pid tag landed (`os-e2e-XXXXXX`) can't name an owner, so
// they fall back to an age cutoff. No suite file runs for two hours.
const UNTAGGED_STALE_MS = 2 * 60 * 60 * 1000;
// A dead run's pid can be recycled by an unrelated live process, which would
// make its dir look owned forever. A dir older than this is reaped regardless.
const PID_REUSE_MS = 6 * 60 * 60 * 1000;

// Free-space thresholds. The whole point: a disk this full CANNOT produce
// trustworthy results, and saying so up front beats debugging the timeouts it
// causes.
const DISK_WARN_GB = 15;
const DISK_FAIL_GB = 3;

// ---------------------------------------------------------------- pure bits

// Decide one $TMPDIR entry's fate. Pure (isAlive/now injected) so the host
// suite can test it without minting real dirs. -> { reap, why }
function classifyTempDir(name, mtimeMs, { isAlive = pidAlive, now = Date.now() } = {}) {
  const m = TEMP_DIR_RE.exec(name);
  const ageMs = now - mtimeMs;
  if (!m) {
    return ageMs > UNTAGGED_STALE_MS
      ? { reap: true, why: `untagged (pre-fix) and ${Math.round(ageMs / 3600000)}h old` }
      : { reap: false, why: 'untagged but recent — may belong to a run in flight' };
  }
  const pid = Number(m[1]);
  if (!isAlive(pid)) return { reap: true, why: `owner pid ${pid} is gone` };
  if (ageMs > PID_REUSE_MS) return { reap: true, why: `pid ${pid} alive but dir is ${Math.round(ageMs / 3600000)}h old (pid reuse)` };
  return { reap: false, why: `owner pid ${pid} is alive` };
}

// The command lines this harness owns and may reap when orphaned. Deliberately
// repo-AGNOSTIC: the sweep's ports are fixed constants shared by every worktree,
// so another worktree's orphan squats OUR port just as effectively as our own.
// An orphan is unowned by construction; there is nobody it could belong to.
//
// Every pattern anchors on argv0 rather than just grepping the line, because a
// bare substring match hits any shell whose command line MENTIONS the name —
// including the `zsh -c … node tests/lib/harness-leaks.js …` that runs this very
// code, and any `pgrep -f serve.js` an operator types. Killing a match like that
// would be catastrophic and is trivially avoidable: a real listener's argv0 is a
// node binary. (Pinned by the self-match case in tests/host/test_harness_leaks.js.)
const NODE_ARGV0 = /^(\S*[/\\])?node(\.exe)?\s/;
const ORPHAN_PATTERNS = [
  { re: (c) => NODE_ARGV0.test(c) && /\bserve\.js\b/.test(c), what: 'serve.js listener' },
  { re: (c) => NODE_ARGV0.test(c) && /\btests[/\\]browser[/\\]os-[\w.-]+\.mjs\b/.test(c), what: 'browser sweep test file' },
  { re: (c) => NODE_ARGV0.test(c) && /\btests[/\\]kernel[/\\][\w.-]+\.js\b/.test(c), what: 'kernel suite test file' },
  { re: (c) => /^(\S*[/\\])?chrome-headless-shell\b/.test(c), what: 'headless Chromium' },
];

// The same argv0 discipline for the "stray serve.js with a live parent" report:
// `pgrep -f serve.js` (which the task asked for by name) is exactly the naive
// match, and it is what surfaced our own shell here during development.
const isServeProc = (command) => NODE_ARGV0.test(command) && /\bserve\.js\b/.test(command);

// Parse `ps -axo pid=,ppid=,command=` into records. Pure, for the host test.
function parsePs(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) out.push({ pid: +m[1], ppid: +m[2], command: m[3] });
  }
  return out;
}

// An orphan = reparented to init (ppid 1) AND one of ours. A live run's
// serve.js has its test file as parent; a live test file has the runner.
function findOrphans(procs, selfPid = process.pid) {
  const out = [];
  for (const p of procs) {
    if (p.ppid !== 1 || p.pid === selfPid || p.pid <= 1) continue;
    const hit = ORPHAN_PATTERNS.find(x => x.re(p.command));
    if (hit) out.push({ ...p, what: hit.what });
  }
  return out;
}

// ------------------------------------------------------------- disk + sizes

function duBytes(dir) {
  // `du -sk` is far cheaper than walking a 150 MB tree from JS, and this runs
  // on every suite start. Best-effort: a size we can't measure reports 0.
  try {
    const out = cp.execFileSync('du', ['-sk', dir], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return (parseInt(out, 10) || 0) * 1024;
  } catch { return 0; }
}

const GB = (b) => (b / 2 ** 30).toFixed(1) + ' GB';

function freeBytes(p) {
  try { const s = fs.statfsSync(p); return s.bavail * s.bsize; } catch { return null; }
}

// --------------------------------------------------------------- the sweeps

function reapTempDirs({ dryRun = false } = {}) {
  const tmp = os.tmpdir();
  const found = [], kept = [];
  let names = [];
  try { names = fs.readdirSync(tmp); } catch { return { found, kept, bytes: 0 }; }
  for (const name of names) {
    if (!name.startsWith('os-')) continue;
    const full = path.join(tmp, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isDirectory()) continue;
    const verdict = classifyTempDir(name, st.mtimeMs);
    if (!verdict.reap) { kept.push({ name, why: verdict.why }); continue; }
    const bytes = duBytes(full);
    found.push({ name, why: verdict.why, bytes });
    if (!dryRun) { try { fs.rmSync(full, { recursive: true, force: true }); } catch {} }
  }
  return { found, kept, bytes: found.reduce((a, f) => a + f.bytes, 0) };
}

// In-tree mkimage temps (`os/os-system.img.tmp-<pid>`). These are .gitignored,
// which is exactly why 409 MB of them went unseen — so they get listed even
// when we can't reap them.
function reapImageTemps({ dryRun = false } = {}) {
  const dir = path.join(ROOT, 'os');
  const found = [], kept = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return { found, kept, bytes: 0 }; }
  for (const name of names) {
    const m = /\.img\.tmp-(\d+)$/.exec(name);
    if (!m) continue;
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (pidAlive(+m[1])) { kept.push({ name, why: `mkimage pid ${m[1]} is still baking` }); continue; }
    found.push({ name, why: `mkimage pid ${m[1]} is gone`, bytes: st.size });
    if (!dryRun) { try { fs.rmSync(full, { force: true }); } catch {} }
  }
  return { found, kept, bytes: found.reduce((a, f) => a + f.bytes, 0) };
}

function listProcs() {
  try {
    return parsePs(cp.execFileSync('ps', ['-axo', 'pid=,ppid=,command='],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch { return []; }
}

// Killing an orphaned TEST FILE re-orphans its own serve.js/Chromium children
// (they were parented to it, not to init), so a single pass under-collects.
// Re-scan until a round finds nothing new — converges in 2-3 rounds.
function reapOrphanProcs({ dryRun = false, rounds = 3, waitMs = 400 } = {}) {
  const killed = [];
  for (let i = 0; i < rounds; i++) {
    const orphans = findOrphans(listProcs());
    const fresh = orphans.filter(o => !killed.some(k => k.pid === o.pid));
    if (!fresh.length) break;
    for (const o of fresh) {
      killed.push(o);
      if (dryRun) continue;
      try { process.kill(o.pid, 'SIGKILL'); } catch {}
    }
    if (dryRun) break;
    // Give the OS a moment to reparent the children we just orphaned. Sync by
    // design — preflight() runs before anything else and has nothing to yield to.
    try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs); } catch {}
  }
  return { killed };
}

// -------------------------------------------------------------- the report

// One pre-flight for every heavy runner. MUST be called AFTER acquireHeavyLock
// (see the safety note at the top). Returns a summary; throws only when the box
// is in a state where no result could be believed.
function preflight({ log = (m) => process.stdout.write(m + '\n'), dryRun = false, name = 'suite' } = {}) {
  const dirs = reapTempDirs({ dryRun });
  const imgs = reapImageTemps({ dryRun });
  const procs = reapOrphanProcs({ dryRun });
  const verb = dryRun ? 'would reap' : 'reaped';

  if (dirs.found.length) {
    log(`[preflight] ${verb} ${dirs.found.length} abandoned $TMPDIR/os-* fixture dir(s), ${GB(dirs.bytes)} reclaimed`);
    for (const f of dirs.found.slice(0, 8)) log(`[preflight]   ${f.name}  (${GB(f.bytes)}; ${f.why})`);
    if (dirs.found.length > 8) log(`[preflight]   … and ${dirs.found.length - 8} more`);
  }
  if (dirs.kept.length) log(`[preflight] left ${dirs.kept.length} os-* dir(s) alone (live owner)`);

  if (imgs.found.length) {
    log(`[preflight] ${verb} ${imgs.found.length} stale mkimage temp(s) in os/, ${GB(imgs.bytes)} reclaimed` +
        ` — these are .gitignored, so git status never showed them`);
    for (const f of imgs.found) log(`[preflight]   os/${f.name}  (${GB(f.bytes)}; ${f.why})`);
  }

  // The check the task asked for by name: `pgrep -f serve.js`, run BEFORE a
  // sweep rather than diagnosed after a red. Orphans are killed; a stray with a
  // LIVE parent is somebody's business, so it is reported, never killed.
  // Re-scanned AFTER the reap, minus what we just killed, so a real run reports
  // only what SURVIVED — anything left here has a live parent and is somebody
  // else's to deal with. (In --dry-run nothing was killed, so the reaped set is
  // subtracted explicitly rather than by re-scanning.)
  const strays = listProcs().filter(p =>
    isServeProc(p.command) &&
    p.pid !== process.pid &&
    !procs.killed.some(k => k.pid === p.pid));
  if (procs.killed.length) {
    log(`[preflight] ${verb} ${procs.killed.length} orphaned harness process(es) (PPID 1 — their runner was killed):`);
    for (const p of procs.killed) log(`[preflight]   pid ${p.pid}  ${p.what}  ${p.command.slice(0, 120)}`);
  }
  if (strays.length) {
    log(`[preflight] WARNING: ${strays.length} serve.js process(es) still running with a LIVE parent —`);
    log('[preflight]   not ours to kill, but they may squat a fixed sweep port (serve.js walks to');
    log('[preflight]   port+1 on EADDRINUSE, so the test can end up talking to the STALE server):');
    for (const p of strays) log(`[preflight]   pid ${p.pid} (ppid ${p.ppid})  ${p.command.slice(0, 120)}`);
  }

  // ENOSPC impersonating a product regression — name it up front.
  const free = freeBytes(ROOT);
  if (free != null) {
    const freeGb = free / 2 ** 30;
    if (freeGb < DISK_FAIL_GB) {
      throw new Error(
        `[preflight] REFUSING to start "${name}": only ${GB(free)} free on the volume holding ${ROOT}. ` +
        `A full disk does not fail as ENOSPC here — it fails as test TIMEOUTS and spurious reds that ` +
        `look exactly like product regressions (that is how 49 GB of leaked fixtures presented). ` +
        `Free space, then re-run.`);
    }
    if (freeGb < DISK_WARN_GB) {
      log(`[preflight] WARNING: ${GB(free)} free — image bakes + per-file fixtures need headroom; ` +
          'a run that runs out mid-flight reports as timeouts, not as ENOSPC.');
    }
  }

  const quiet = !dirs.found.length && !imgs.found.length && !procs.killed.length && !strays.length;
  if (quiet) log(`[preflight] clean: no abandoned fixtures, no orphaned serve.js, ${free != null ? GB(free) + ' free' : 'disk unknown'}`);
  return { dirs, imgs, procs, strays, freeBytes: free };
}

module.exports = {
  preflight, reapTempDirs, reapImageTemps, reapOrphanProcs,
  classifyTempDir, parsePs, findOrphans, isServeProc,
  TEMP_DIR_RE, UNTAGGED_STALE_MS, PID_REUSE_MS,
};

// `node tests/lib/harness-leaks.js [--dry-run]` — inspect/reap by hand. This
// entry point deliberately does NOT take the heavy lock (it is a diagnostic you
// want available while a suite is running); it is safe to run any time because
// every reap is gated on a dead owner, but it will not tell you a run is in
// flight — check the lock file if you care.
if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  try { preflight({ dryRun, name: 'manual' }); }
  catch (e) { process.stderr.write((e.message || e) + '\n'); process.exit(1); }
}
