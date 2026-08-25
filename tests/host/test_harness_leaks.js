'use strict';
// Unit coverage for the PURE decision logic of tests/lib/harness-leaks.js —
// the startup reaper that closes the two false-signal leaks (abandoned $TMPDIR
// os-* fixture dirs; orphaned serve.js listeners squatting fixed sweep ports).
//
// The dangerous half of a reaper is not what it deletes, it is what it deletes
// BY MISTAKE — a live run's fixture, or a colleague's running server. Those
// decisions are pure functions here precisely so they can be pinned without
// minting 150 MB dirs or killing anything, and that is what this file pins.
//
//   node tests/host/test_harness_leaks.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  classifyTempDir, parsePs, findOrphans, isServeProc, UNTAGGED_STALE_MS, PID_REUSE_MS,
} = require('../lib/harness-leaks.js');
const { mkdtempOwned, track, untrack, cleanupAll, trackedDirs } = require('../lib/harness-temp.js');

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n         ' + (e.message || e)); failures++; }
};

const NOW = 1_800_000_000_000;
const dead = () => false;
const alive = () => true;

// ---- classifyTempDir: the "never delete a live run's fixture" contract ----

check('a pid-tagged dir whose owner is gone is reaped', () => {
  const v = classifyTempDir('os-e2e-4242-Ab3xYz', NOW - 60_000, { isAlive: dead, now: NOW });
  assert.strictEqual(v.reap, true);
  assert.match(v.why, /4242/);
});

check('a pid-tagged dir whose owner is ALIVE is left alone', () => {
  // The load-bearing case: a hand-run `node tests/kernel/test_wm.js` takes no
  // heavy lock, so nothing but this check stands between it and deletion.
  const v = classifyTempDir('os-e2e-4242-Ab3xYz', NOW - 60_000, { isAlive: alive, now: NOW });
  assert.strictEqual(v.reap, false);
});

// ---- provableOnly (#725 CP3 finding 1): the automatic gate-time policy ----
// The default policy reaps a LIVE-owner dir past PID_REUSE_MS and an
// untagged dir on age alone — heuristics a human-invoked reap may take, but
// an AUTOMATIC gate-time recovery may not: deleting a live run's fixture
// manufactures that run's failure, #725's own false-red class in
// destructive form. Under provableOnly, only a dead owner licenses a reap.
check('provableOnly: a LIVE owner is never reaped, however old the dir', () => {
  const v = classifyTempDir('os-e2e-4242-Ab3xYz', NOW - PID_REUSE_MS - 1,
    { isAlive: alive, now: NOW, provableOnly: true });
  assert.strictEqual(v.reap, false);
  assert.match(v.why, /heuristic, not a proof/);
  // …while the default policy DOES reap it (the human-invoked behavior,
  // unchanged — this pair is what pins the two policies apart).
  assert.strictEqual(classifyTempDir('os-e2e-4242-Ab3xYz', NOW - PID_REUSE_MS - 1,
    { isAlive: alive, now: NOW }).reap, true);
});
check('provableOnly: an untagged old dir is kept and named unprovable', () => {
  const v = classifyTempDir('os-e2e-XXXXXX', NOW - UNTAGGED_STALE_MS - 1,
    { isAlive: dead, now: NOW, provableOnly: true });
  assert.strictEqual(v.reap, false);
  assert.match(v.why, /UNPROVABLE/);
  assert.strictEqual(classifyTempDir('os-e2e-XXXXXX', NOW - UNTAGGED_STALE_MS - 1,
    { isAlive: dead, now: NOW }).reap, true);
});
check('provableOnly: a DEAD owner still licenses the reap', () => {
  const v = classifyTempDir('os-e2e-4242-Ab3xYz', NOW - 60_000,
    { isAlive: dead, now: NOW, provableOnly: true });
  assert.strictEqual(v.reap, true);
  assert.match(v.why, /4242/);
});

check('a live-pid dir older than the pid-reuse horizon IS reaped', () => {
  // Otherwise a recycled pid pins an abandoned dir forever.
  const v = classifyTempDir('os-e2e-4242-Ab3xYz', NOW - PID_REUSE_MS - 1, { isAlive: alive, now: NOW });
  assert.strictEqual(v.reap, true);
  assert.match(v.why, /reuse/);
});

check('custom prefixes (os-apps-, os-shell-) still parse their owner', () => {
  assert.strictEqual(classifyTempDir('os-apps-99-QQQQQQ', NOW, { isAlive: dead, now: NOW }).reap, true);
  assert.strictEqual(classifyTempDir('os-apps-99-QQQQQQ', NOW, { isAlive: alive, now: NOW }).reap, false);
});

check('an UNTAGGED pre-fix dir is reaped only once it is old', () => {
  const nm = 'os-e2e-XXXXXX';
  assert.strictEqual(classifyTempDir(nm, NOW - 60_000, { isAlive: dead, now: NOW }).reap, false,
    'a recent untagged dir may belong to a run in flight');
  assert.strictEqual(classifyTempDir(nm, NOW - UNTAGGED_STALE_MS - 1, { isAlive: dead, now: NOW }).reap, true);
});

// ---- findOrphans: PPID 1 is the ONLY licence to kill ----

const PS = [
  '  501     1 node /repo/serve.js /repo 3197',                       // orphan
  '  502   499 node /repo/serve.js /repo 3197',                       // live parent
  '  503     1 /Users/x/.../chrome-headless-shell --headless',        // orphan
  '  504     1 node /repo/tests/browser/os-wm.mjs',                   // orphan
  '  505   400 node /repo/tests/kernel/test_wm.js',                   // live parent
  '  506     1 node /repo/tools/mkimage.js --packages=all',           // orphan since #725
  '  507     1 /usr/sbin/cupsd -l',                                   // unrelated
  '  510     1 /repo/.venv/bin/python3 tests/run.py --types=ast',     // orphan since #725
  '  511   400 python3.12 tests/run.py --types=ast',                  // live parent
  '  512     1 /bin/zsh -c python3 tests/run.py',                     // mention, not python
  // The self-match trap, hit for real during development: a shell whose command
  // line merely MENTIONS serve.js. `pgrep -f serve.js` matches this; a reaper
  // that did too would SIGKILL an operator's shell.
  '  508     1 /bin/zsh -c cd /repo && node -c serve.js && pgrep -f serve.js',
  '  509     1 pgrep -f serve.js',
].join('\n');

check('parsePs reads pid/ppid/command', () => {
  const rows = parsePs(PS);
  assert.strictEqual(rows.length, 12);
  assert.deepStrictEqual(rows[0], { pid: 501, ppid: 1, command: 'node /repo/serve.js /repo 3197' });
});

check('findOrphans takes only PPID-1 harness processes', () => {
  const got = findOrphans(parsePs(PS), /* selfPid */ 999).map(o => o.pid).sort();
  assert.deepStrictEqual(got, [501, 503, 504, 506, 510]);
});

check('a serve.js with a LIVE parent is never an orphan', () => {
  assert.ok(!findOrphans(parsePs(PS), 999).some(o => o.pid === 502),
    'killing a running lane\'s server is the failure this reaper must not have');
});

check('a running kernel e2e is never an orphan', () => {
  assert.ok(!findOrphans(parsePs(PS), 999).some(o => o.pid === 505));
});

check('unrelated PPID-1 processes are untouched', () => {
  const got = findOrphans(parsePs(PS), 999).map(o => o.pid);
  assert.ok(!got.includes(507), 'cupsd is not ours');
});

// #725 inverted the old "a detached mkimage is a bake, not a leak" reading:
// the 2026-08-20 incident's concrete starvation WAS an adopted mkimage (its
// launcher dead, multi-GB RSS, image nobody would consume). A deliberate
// bake always has a live parent — backgrounding builds is forbidden — so
// ppid 1 is decisive here exactly as for serve.js.
check('an ORPHANED mkimage.js is reaped; one with a live parent never is', () => {
  const got = findOrphans(parsePs(PS), 999);
  assert.ok(got.some(o => o.pid === 506 && o.what === 'mkimage.js bake'));
  assert.ok(!findOrphans(parsePs('  600   400 node /repo/tools/mkimage.js --quiet'), 999).length,
    'a bake mid-flight under a live serve.js/image-fixture must never be killed');
});

check('an ORPHANED run.py batch is reaped; live-parent and mere mentions are not', () => {
  const got = findOrphans(parsePs(PS), 999);
  assert.ok(got.some(o => o.pid === 510 && o.what === 'run.py batch'),
    'python cannot preload parent-watch — the reaper is its only net (#725)');
  assert.ok(!got.some(o => o.pid === 511), 'a live runner\'s py batch is not an orphan');
  assert.ok(!got.some(o => o.pid === 512), 'a shell that mentions run.py is not python');
});

check('a shell that merely MENTIONS serve.js is not a serve.js', () => {
  const got = findOrphans(parsePs(PS), 999).map(o => o.pid);
  assert.ok(!got.includes(508), 'would have SIGKILLed an operator shell');
  assert.ok(!got.includes(509), 'would have SIGKILLed a pgrep');
  assert.ok(!isServeProc('/bin/zsh -c node -c serve.js'));
  assert.ok(!isServeProc('pgrep -f serve.js'));
  assert.ok(isServeProc('node /repo/serve.js /repo 3197'));
  assert.ok(isServeProc('/Users/x/Library/pnpm/nodejs/25.8.2/bin/node /repo/serve.js /repo 3197'));
});

check('findOrphans never returns itself or init', () => {
  assert.ok(!findOrphans(parsePs('  501     1 node /repo/serve.js /repo 3197'), 501).length);
  assert.ok(!findOrphans(parsePs('    1     1 node /repo/serve.js /repo 3197'), 999).length);
});

// ---- harness-temp: the name really is reap-able, and exit really rms ----

check('mkdtempOwned tags the dir with this pid and registers it', () => {
  const dir = mkdtempOwned('os-selftest-');
  try {
    assert.ok(fs.existsSync(dir));
    assert.strictEqual(path.dirname(dir), path.resolve(os.tmpdir()));
    const v = classifyTempDir(path.basename(dir), Date.now(), { isAlive: dead, now: Date.now() });
    assert.strictEqual(v.reap, true, `reaper cannot parse an owner out of ${path.basename(dir)}`);
    assert.strictEqual(
      classifyTempDir(path.basename(dir), Date.now(), { isAlive: alive, now: Date.now() }).reap, false);
    assert.ok(trackedDirs().includes(dir));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); untrack(dir); }
});

check('cleanupAll removes tracked dirs and forgets them', () => {
  const dir = mkdtempOwned('os-selftest-');
  fs.writeFileSync(path.join(dir, 'payload'), 'x'.repeat(1024));
  cleanupAll();
  assert.ok(!fs.existsSync(dir), 'cleanupAll left the dir behind');
  assert.deepStrictEqual(trackedDirs(), []);
});

check('the process-exit hook really fires (child process)', () => {
  // The whole clean-exit half of the fix rides on this hook, so prove it in a
  // real process rather than by inspecting the listener list.
  const cp = require('child_process');
  const r = cp.spawnSync(process.execPath, ['-e', `
    const { mkdtempOwned } = require(${JSON.stringify(path.resolve(__dirname, '../lib/harness-temp.js'))});
    const d = mkdtempOwned('os-selftest-exit-');
    require('fs').writeFileSync(d + '/payload', 'x');
    console.log(d);
  `], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  const dir = r.stdout.trim();
  assert.ok(dir, 'child printed no dir');
  assert.ok(!fs.existsSync(dir), `exit hook did not remove ${dir}`);
});

check('an UNCAUGHT THROW still cleans up', () => {
  const cp = require('child_process');
  const r = cp.spawnSync(process.execPath, ['-e', `
    const { mkdtempOwned } = require(${JSON.stringify(path.resolve(__dirname, '../lib/harness-temp.js'))});
    console.log(mkdtempOwned('os-selftest-throw-'));
    throw new Error('boom');
  `], { encoding: 'utf8' });
  assert.notStrictEqual(r.status, 0, 'the throw should still fail the process');
  const dir = r.stdout.trim();
  assert.ok(dir);
  assert.ok(!fs.existsSync(dir), `throw path left ${dir} behind`);
});

// ---- the #725 blocked-parent chain, live ----------------------------------
// image-fixture.js / serve.js / tests/run.js now preload parent-watch into
// the children they spawn, because a parent BLOCKED in spawnSync (or dead
// outright) can never reach them — the 2026-08-20 adopted-mkimage incident.
// This proves the chain those preloads rely on with real processes: a
// launcher spawns a long-lived child under `-r parent-watch`, the launcher
// is SIGKILLed (runs no handler, exactly the uncoverable case), and the
// child must notice the reparent and exit on its own within the poll
// interval. Cheap (no bake — the mechanism is identical for `-e` and
// mkimage.js), ~2-3s.
(async () => {
  const cp = require('child_process');
  const PW = path.resolve(__dirname, '../lib/parent-watch.js');
  const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const launcherSrc = `
    const cp = require('child_process');
    const c = cp.spawn(process.execPath,
      ['-r', ${JSON.stringify(PW)}, '-e', 'setInterval(() => {}, 100)'],
      { stdio: 'ignore', env: { ...process.env, CC_HARNESS_GROUP_LEADER: '0' } });
    console.log('CHILD=' + c.pid);
    // Model the blocked parent: no event loop turns, nothing to service.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
  `;
  const launcher = cp.spawn(process.execPath, ['-e', launcherSrc],
    { stdio: ['ignore', 'pipe', 'ignore'] });
  const childPid = await new Promise((resolve) => {
    let buf = '';
    const to = setTimeout(() => resolve(null), 10000);
    launcher.stdout.on('data', (d) => {
      buf += d;
      const m = /CHILD=(\d+)/.exec(buf);
      if (m) { clearTimeout(to); resolve(+m[1]); }
    });
    launcher.on('exit', () => { clearTimeout(to); resolve(null); });
  });
  check('#725 preload chain: launcher spawned a live preloaded child', () => {
    assert.ok(childPid, 'no CHILD= line from the launcher');
    assert.ok(pidAlive(childPid), 'child died before the experiment started');
  });
  // Let the child's node BOOTSTRAP before orphaning it. parent-watch reads
  // process.ppid once at startup and deliberately installs nothing when it
  // is already 1 ("parentless at startup = intentional detach") — so a
  // parent that dies inside the child's ~100ms bootstrap leaves the child
  // unwatched. Found live by this control's first run. That window is a
  // recorded limitation of the preload, not of this test: the startup
  // reaper's mkimage/run.py/serve patterns are the net under it.
  await new Promise((r) => setTimeout(r, 750));
  launcher.kill('SIGKILL');
  let died = false;
  for (let i = 0; i < 50 && !(died = !pidAlive(childPid)); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  check('#725 preload chain: the child exits ITSELF after its parent is SIGKILLed', () => {
    if (!died && childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} }  // never leak the probe
    assert.ok(died, `pid ${childPid} still alive 5s after its parent died — parent-watch did not fire`);
  });

  console.log(failures ? `\n${failures} harness-leak check(s) FAILED` : '\nAll harness-leak checks passed');
  process.exit(failures ? 1 : 0);
})();
