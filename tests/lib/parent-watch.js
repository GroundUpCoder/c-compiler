'use strict';
// tests/lib/parent-watch.js — a `node -r` PRELOAD that suite-runner.js injects
// into every test file it spawns. It makes a test file die with its runner.
//
// THE HOLE IT PLUGS. suite-runner spawns each file `detached: true` so the file
// becomes its own process-GROUP leader — that is what lets the per-file timeout
// SIGKILL the whole group and take the test's serve.js + Chromium with it. But
// detaching cuts the other way too: the test file is no longer in the runner's
// group, so when the RUNNER itself is killed from outside (the 600s call-ceiling
// SIGKILL), nothing reaches the children. The runner's own SIGINT/SIGTERM
// handler cannot help either — SIGKILL runs no handler. Result, observed: 70
// serve.js processes reparented to init, squatting the sweep's fixed ports, so
// the next run's tests polled those ports and got a STALE server. Spurious reds.
//
// The fix has to live INSIDE the test process, and it has to be a poll rather
// than a handler, because the event it must notice (its parent dying) delivers
// no signal here. So: remember our ppid at startup, and when the OS reparents us
// to init (ppid changes), tear down our own process group. That is the same
// idiom the --under-load generators in suite-runner.js already use, and it works
// no matter HOW the runner died — SIGTERM, SIGKILL, or a panic.
//
// Preload rather than a wrapper process: zero extra pids, no stdio rewiring, no
// exit-code laundering. `process.argv` is unaffected (node strips -r), so the
// test file sees exactly what it saw before, and the runner's pass/fail/timeout
// classification is unchanged.
//
// Which death this covers: the RUNNER-KILLED-FROM-OUTSIDE one (SIGTERM and
// SIGKILL alike). Clean exit is covered by the test's own teardown +
// harness-temp.js; the per-file timeout by suite-runner's existing group kill;
// anything that predates or escapes all three by the startup reaper in
// tests/lib/harness-leaks.js.
const POLL_MS = 1000;
const INITIAL_PPID = process.ppid;

// The group kill is only OURS to do when we really are the group leader, which
// is true exactly when suite-runner spawned us detached — it says so explicitly
// rather than us guessing from a ps call on the way out the door.
const GROUP_LEADER = process.env.CC_HARNESS_GROUP_LEADER === '1';

// Already parentless at startup: nothing to watch for.
if (INITIAL_PPID > 1) {
  const timer = setInterval(() => {
    if (process.ppid === INITIAL_PPID) return;
    clearInterval(timer);
    process.stderr.write(
      `\n[parent-watch] runner ${INITIAL_PPID} is gone (reparented to ${process.ppid}) — ` +
      'tearing down this test\'s process group so its serve.js/Chromium cannot squat a port.\n');
    // Best-effort fixture cleanup FIRST: we are the last code that will run in
    // this process, and the dirs are ~150 MB each.
    try { require('./harness-temp.js').cleanupAll(); } catch {}
    if (GROUP_LEADER) {
      // Kills us too — the group includes this process. Anything after this
      // line only runs if the kill failed.
      try { process.kill(-process.pid, 'SIGKILL'); } catch {}
    }
    process.exit(137);
  }, POLL_MS);
  // Never hold the event loop open: a test that finishes normally must exit
  // exactly when it always did.
  timer.unref();
}
