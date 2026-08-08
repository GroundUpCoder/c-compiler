'use strict';
// tests/lib/heavy-lock.js — a host-wide "only one heavy test job at a time" gate.
//
// WHY THIS EXISTS. The kernel suite and the browser OS sweep are the two
// RAM-heavy suites: the kernel suite fans out several concurrent full-OS boots
// (each an os/boot.js node at ~2-3 GB), and the sweep drives a real Chromium
// per file. A SINGLE runner is bounded — the kernel pool by the memory-aware
// RAM budget (see suite-runner.js: ramBudgetGb), the sweep by being serial
// (todos/0045 one-kernel-per-origin lock). What nothing bounded until now was
// TWO heavy runners at once: two work lanes, a stray re-run, or a coordinator
// kicking a suite while another still holds one. Their process trees stack and
// exhaust RAM.
//
// On 2026-07-25 exactly that took the whole machine down: the kernel suite
// (~16.7 GB across 8 node procs) overlapping browser Chromium work drove a
// jetsam death spiral → a launchservicesd read/write-lock convoy → the
// WindowServer watchdog fired and killed the GUI (44-day uptime intact — not a
// reboot, the desktop just vanished to the login screen). Post-mortem lives in
// the "Machine Crash Investigation Log" thread.
//
// POLICY (todos/0342, which also closed todos/0303). The unit of exclusion is
// the process tree that spends the RAM — a full-OS boot (`node os/boot.js`,
// ~2-4 GB) or an os.html boot in a Chromium — so the guard runs at the seams
// every such boot funnels through, NOT at a list of callers (caller lists
// rot):
//   - the dispatcher (tests/run.js) ACQUIRES the lock up front for the whole
//     selected run whenever a heavy suite is in the set (#561 — closing the
//     windows before and between the heavy rows in which a sibling could
//     seize the lock mid-gate), and FAILS FAST (exit 3) when another heavy
//     job owns the host;
//   - the two suite runners (tests/kernel/run.js, tests/browser/os-sweep.mjs)
//     JOIN at startup (#561): under a dispatcher gate they ride its
//     reservation re-entrantly; hand-run there is no marker, so they acquire,
//     own, and FAIL FAST (exit 3) exactly as they always did;
//   - os/boot.js itself JOINS at startup (joinHeavyLock), so a single-file
//     kernel e2e, a bench tool, and a bare `node os/boot.js` are all guarded
//     no matter who spawned them (`--wait-lock[=SECS]` is boot.js's explicit
//     loud-wait opt-in for an interactive reproduce);
//   - tests/browser/lib/os-harness.mjs JOINS before it starts a serve.js or a
//     Chromium, so a hand-run single os-*.mjs is guarded too.
// The one uncoverable path is a human browser tab against a dev serve.js — no
// repo process can lock a human's browser (the 0045 Web Lock guards image
// coherence there, not RAM). Recorded as an exclusion in todos/done/0342.
// Exit 3 always means LOCK HELD (with a `[heavy-lock]` stderr marker — match
// BOTH, an init script can exit 3 legitimately); it is never a test failure.
//
// RE-ENTRANCY. Owning the lock exports CC_HEAVY_LOCK_PID=<owner pid> to child
// processes. joinHeavyLock treats the lock as already held for this process
// tree only when BOTH hold: the marker pid is ALIVE and it EQUALS the lock
// file's recorded holder. That is how the kernel suite's own fan-out of boots
// cannot deadlock against the lock its runner holds — the children join
// without ownership and without a release duty. An orphaned child of a killed
// runner carries a dead marker, fails the liveness check, and falls through
// to a loud acquire; a spawn site that builds `env` from scratch severs the
// marker and that boot refuses loudly. Every failure mode of the mechanism
// degrades to a refusal, never to silent stacking.
//
// Light suites (unit/host/blockfs/ext/bench) never take it — PERMISSION, not
// a gap (ruled in todos/done/0303): they spawn neither a full-OS boot nor a
// Chromium, and since the guard rides the boot itself, a light suite that
// ever spawns one gets locked through that boot anyway.
//
// The lock is advisory + self-healing: a holder that died (e.g. was killed by
// the very OOM this guards) leaves a stale file, which the next contender
// detects (dead pid) and steals. Escape hatch: CC_NO_HEAVY_LOCK=1 for a host
// that is genuinely isolated (its own container/VM), where serialization is
// pointless.

const fs = require('fs');
const os = require('os');
const path = require('path');

// One well-known path per host — os.tmpdir() is shared by every runner on the
// machine, which is exactly the scope we want to serialize.
const LOCK_PATH = path.join(os.tmpdir(), 'cc-heavy-tests.lock');

// signal 0 doesn't deliver — it only probes existence/permission. EPERM means
// the pid exists but is owned by another user (still "alive" for our purposes).
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; }
}

function readHolder() {
  try { return JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8')); }
  catch { return null; } // missing, or a half-written/garbage file → treat as none
}

// Synchronous sleep without a child process — the wait loop runs before any
// event loop work exists to keep alive.
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The contend-or-refuse core shared by acquireHeavyLock and joinHeavyLock.
// waitMs > 0 turns a live-holder refusal into a LOUD poll (a status line
// every 30s — todos/0171: never nap out a clock silently) that acquires when
// the lock frees and exits 3 at the deadline (Infinity = no deadline).
function contendForLock({ name, waitMs = 0 }) {
  const meta = () => JSON.stringify({
    pid: process.pid,
    name,
    host: os.hostname(),
    startedAt: new Date().toISOString(),
    argv: process.argv.slice(1),
  });

  const t0 = Date.now();
  let lastPrint = -Infinity;
  for (;;) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx'); // O_EXCL: atomic create-or-fail
      fs.writeSync(fd, meta());
      fs.closeSync(fd);
      break; // we own it
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const h = readHolder();
      if (h && h.pid !== process.pid && pidAlive(h.pid)) {
        const elapsed = Date.now() - t0;
        if (elapsed < waitMs) {
          if (Date.now() - lastPrint >= 30000) {
            process.stderr.write(
              `[heavy-lock] waiting for ${h.name} (pid ${h.pid}) to release the ` +
              `heavy-test lock — ${Math.round(elapsed / 1000)}s elapsed` +
              (Number.isFinite(waitMs) ? ` of a ${Math.round(waitMs / 1000)}s deadline` : '') + '\n');
            lastPrint = Date.now();
          }
          sleepMs(1000);
          continue;
        }
        process.stderr.write(
          `\n[heavy-lock] REFUSING to start "${name}": another heavy test job owns this host.\n` +
          `  held by: ${h.name} (pid ${h.pid}) on ${h.host}, since ${h.startedAt}\n` +
          (waitMs > 0 ? `  (--wait-lock deadline reached after ${Math.round(elapsed / 1000)}s.)\n` : '') +
          `  The RAM-heavy jobs (full-OS boots, the kernel suite, the browser OS sweep)\n` +
          `  must run ONE AT A TIME; overlapping them exhausts memory and has crashed\n` +
          `  this machine (2026-07-25 WindowServer watchdog kill). Wait for it to finish\n` +
          `  and re-run — os/boot.js takes --wait-lock[=SECS] for an explicit loud wait —\n` +
          `  or set CC_NO_HEAVY_LOCK=1 if this host is isolated (its own container/VM).\n\n`);
        process.exit(3);
      }
      // Stale (dead/malformed holder): steal it, then loop to re-create.
      try { fs.unlinkSync(LOCK_PATH); } catch { /* raced with another stealer */ }
    }
  }

  // Ownership marker for descendants (the re-entrancy contract above): a
  // child full-OS boot spawned by this process joins instead of deadlocking.
  process.env.CC_HEAVY_LOCK_PID = String(process.pid);

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (process.env.CC_HEAVY_LOCK_PID === String(process.pid)) {
      delete process.env.CC_HEAVY_LOCK_PID;
    }
    const h = readHolder();
    if (h && h.pid === process.pid) { try { fs.unlinkSync(LOCK_PATH); } catch { /* gone */ } }
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { release(); process.exit(130); });
  }
  return release;
}

// Acquire the host heavy-test lock or exit(3). Returns a release() that is also
// wired to run on normal exit and on SIGINT/SIGTERM/SIGHUP, so a lock is never
// left behind by an orderly shutdown (only a hard kill leaves a stale file, and
// the next contender reclaims that). The dispatcher (tests/run.js) uses this
// for its whole-gate reservation (#561): the gate always OWNS the lock — it
// never joins re-entrantly, because two gates are exactly what must not
// overlap. (The suite runners themselves joinHeavyLock since #561: two runners
// still cannot overlap — either each owns the lock as before, or they share
// ONE dispatcher ancestor, which runs its suites strictly sequentially.)
function acquireHeavyLock({ name = 'heavy suite' } = {}) {
  if (process.env.CC_NO_HEAVY_LOCK === '1') return () => {};
  return contendForLock({ name });
}

// Join the host heavy-test lock at a full-OS-boot seam (os/boot.js startup,
// tests/browser/lib/os-harness.mjs) or at a suite-runner startup under a
// dispatcher gate (#561). Three outcomes, checked in this order:
//   1. CC_NO_HEAVY_LOCK=1 → no-op (the documented isolated-host escape).
//   2. CC_HEAVY_LOCK_PID names a pid that is ALIVE and EQUALS the lock file's
//      recorded holder → re-entrant join: an ancestor owns the lock for its
//      own lifetime; return without ownership and without a release duty.
//      (Both conditions, not either — a dead or mismatched marker is ignored.)
//   3. Otherwise → acquireHeavyLock semantics: own the lock, or exit 3 naming
//      the live holder. waitMs > 0 (boot.js --wait-lock) polls loudly first.
function joinHeavyLock({ name = 'heavy job', waitMs = 0 } = {}) {
  if (process.env.CC_NO_HEAVY_LOCK === '1') return () => {};
  const marker = Number.parseInt(process.env.CC_HEAVY_LOCK_PID || '', 10);
  if (pidAlive(marker)) {
    const h = readHolder();
    if (h && h.pid === marker) return () => {}; // re-entrant join — no release duty
  }
  return contendForLock({ name, waitMs });
}

// pidAlive is re-exported for tests/lib/harness-leaks.js: the startup reaper
// makes exactly the same "is the owner still there?" call this lock's
// stale-holder steal does, and one implementation of it is enough.
module.exports = { acquireHeavyLock, joinHeavyLock, LOCK_PATH, pidAlive };
