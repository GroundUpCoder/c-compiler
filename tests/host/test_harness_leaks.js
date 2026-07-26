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
  '  506     1 node /repo/tools/mkimage.js --packages=all',           // not ours to kill
  '  507     1 /usr/sbin/cupsd -l',                                   // unrelated
  // The self-match trap, hit for real during development: a shell whose command
  // line merely MENTIONS serve.js. `pgrep -f serve.js` matches this; a reaper
  // that did too would SIGKILL an operator's shell.
  '  508     1 /bin/zsh -c cd /repo && node -c serve.js && pgrep -f serve.js',
  '  509     1 pgrep -f serve.js',
].join('\n');

check('parsePs reads pid/ppid/command', () => {
  const rows = parsePs(PS);
  assert.strictEqual(rows.length, 9);
  assert.deepStrictEqual(rows[0], { pid: 501, ppid: 1, command: 'node /repo/serve.js /repo 3197' });
});

check('findOrphans takes only PPID-1 harness processes', () => {
  const got = findOrphans(parsePs(PS), /* selfPid */ 999).map(o => o.pid).sort();
  assert.deepStrictEqual(got, [501, 503, 504]);
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
  assert.ok(!got.includes(506), 'a detached mkimage is a bake, not a leak');
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

console.log(failures ? `\n${failures} harness-leak check(s) FAILED` : '\nAll harness-leak checks passed');
process.exit(failures ? 1 : 0);
