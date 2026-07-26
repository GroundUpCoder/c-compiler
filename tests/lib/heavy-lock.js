'use strict';
// tests/lib/heavy-lock.js — a host-wide "only one heavy suite at a time" gate.
//
// WHY THIS EXISTS. The kernel suite and the browser OS sweep are the two
// RAM-heavy suites: the kernel suite fans out several concurrent full-OS boots
// (each an os/boot.js node at ~2-3 GB), and the sweep drives a real Chromium
// per file. A SINGLE runner is bounded — the kernel pool by the memory-aware
// `jobs` cap (see suite-runner.js: memoryCappedJobs), the sweep by being serial
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
// POLICY. Heavy suites acquire this lock at startup and FAIL FAST (exit 3)
// rather than pile on when another heavy runner already owns the host. It is
// mutual exclusion ACROSS runner processes and ACROSS suite kinds — a running
// kernel suite blocks a sweep and vice-versa, because it was their overlap that
// crashed the box. Intra-runner parallelism stays governed where it already is.
// Light suites (unit/host/blockfs/ext/bench) never take it.
//
// The lock is advisory + self-healing: a holder that died (e.g. was killed by
// the very OOM this guards) leaves a stale file, which the next runner detects
// (dead pid) and steals. Escape hatch: CC_NO_HEAVY_LOCK=1 for a host that is
// genuinely isolated (its own container/VM), where serialization is pointless.

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

// Acquire the host heavy-test lock or exit(3). Returns a release() that is also
// wired to run on normal exit and on SIGINT/SIGTERM/SIGHUP, so a lock is never
// left behind by an orderly shutdown (only a hard kill leaves a stale file, and
// the next runner reclaims that).
function acquireHeavyLock({ name = 'heavy suite' } = {}) {
  if (process.env.CC_NO_HEAVY_LOCK === '1') return () => {};

  const meta = () => JSON.stringify({
    pid: process.pid,
    name,
    host: os.hostname(),
    startedAt: new Date().toISOString(),
    argv: process.argv.slice(1),
  });

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
        process.stderr.write(
          `\n[heavy-lock] REFUSING to start "${name}": another heavy test runner owns this host.\n` +
          `  held by: ${h.name} (pid ${h.pid}) on ${h.host}, since ${h.startedAt}\n` +
          `  The RAM-heavy suites (kernel suite, browser OS sweep — full-OS boots /\n` +
          `  real Chromium) must run ONE AT A TIME; overlapping them exhausts memory\n` +
          `  and has crashed this machine (2026-07-25 WindowServer watchdog kill).\n` +
          `  Wait for it to finish and re-run, or set CC_NO_HEAVY_LOCK=1 if this host\n` +
          `  is isolated (its own container/VM).\n\n`);
        process.exit(3);
      }
      // Stale (dead/malformed holder): steal it, then loop to re-create.
      try { fs.unlinkSync(LOCK_PATH); } catch { /* raced with another stealer */ }
    }
  }

  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    const h = readHolder();
    if (h && h.pid === process.pid) { try { fs.unlinkSync(LOCK_PATH); } catch { /* gone */ } }
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { release(); process.exit(130); });
  }
  return release;
}

// pidAlive is re-exported for tests/lib/harness-leaks.js: the startup reaper
// makes exactly the same "is the owner still there?" call this lock's
// stale-holder steal does, and one implementation of it is enough.
module.exports = { acquireHeavyLock, LOCK_PATH, pidAlive };
