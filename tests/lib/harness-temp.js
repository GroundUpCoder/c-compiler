'use strict';
// tests/lib/harness-temp.js — OWNERSHIP for the per-fixture temp dirs the OS
// e2es mint in $TMPDIR (tests/kernel/lib/drive.js freshImage).
//
// THE LEAK THIS CLOSES. freshImage() used to mkdtemp `os-e2e-XXXXXX` and hand
// the path back with "the caller owns cleanup; most e2es leak the tmpdir like
// they always did and let the OS sweep /tmp". macOS does not sweep /var/folders
// on any useful horizon, and a single fixture is 144-197 MB — so every run that
// did not exit cleanly left a pile behind. Measured: 779 abandoned dirs / 49 GB
// (which filled the disk, and ENOSPC then presented itself as test TIMEOUTS and
// spurious failures — a product regression that was not one), plus 39 more /
// 4.3 GB a fortnight later.
//
// TWO HALVES, because no single mechanism covers every death:
//
//   1. This module — process-lifetime cleanup. track(dir) registers a dir;
//      normal exit, an uncaught throw, and SIGINT/SIGTERM all rm it. Covers the
//      clean-exit and orderly-interrupt deaths.
//   2. tests/lib/harness-leaks.js — a STARTUP reaper. A SIGKILLed process runs
//      no handler, by definition, so the dirs it owned can only be collected by
//      somebody else, later. Each dir carries its owner's pid in its NAME, so
//      the reaper can tell "abandoned" from "in use by a run happening right
//      now" without guessing.
//
// The pid tag is what makes (2) safe: reaping is `owner pid is dead`, never
// `looks old`, so a concurrently running suite — or a hand-run single e2e that
// takes no heavy lock — can never have its live fixture deleted out from under
// it. See harness-leaks.js reapTempDirs for the pid-reuse fallback.
const fs = require('fs');
const os = require('os');
const path = require('path');

// Node's mkdtemp appends exactly 6 random chars to the template. Tagging the
// prefix with our pid makes the dir self-identifying:
//   os-e2e-<pid>-XXXXXX      (the reaper's TEMP_DIR_RE parses <pid> back out)
function mkdtempOwned(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}${process.pid}-`));
  return track(dir);
}

const tracked = new Set();
let hooked = false;

function track(dir) {
  tracked.add(dir);
  installHooks();
  return dir;
}

// A test that removes its own dir (the ~60 kernel e2es that already do) can
// drop it here; rmSync is force:true anyway, so forgetting is harmless.
function untrack(dir) { tracked.delete(dir); }

function cleanupAll() {
  for (const dir of tracked) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  tracked.clear();
}

function installHooks() {
  if (hooked) return;
  hooked = true;
  process.on('exit', cleanupAll);
  // SIGINT/SIGTERM: clean, then re-raise with the DEFAULT disposition so the
  // exit status still reports the signal (a handler that just exit(0)s would
  // launder a ^C into a pass). SIGKILL is unhandleable — that is the startup
  // reaper's job, not this module's.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(sig, () => {
      cleanupAll();
      process.removeAllListeners(sig);
      try { process.kill(process.pid, sig); } catch { process.exit(1); }
    });
  }
}

module.exports = { mkdtempOwned, track, untrack, cleanupAll, trackedDirs: () => [...tracked] };
