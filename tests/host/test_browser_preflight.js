'use strict';
// tests/host/test_browser_preflight.js — the browser install pre-flight
// (#559), failure paths exercised on every run (the test_tree_guard.js
// pattern: a guard whose failure path was never exercised is not a guard).
//
// THE INCIDENT THIS PINS. tests/browser/node_modules is gitignored, so a
// fresh `git worktree` lacks it; Node resolution then falls through to a
// drifted ancestor playwright and checkPlaywrightPin() fails EVERY sweep
// member — at launch time, which in a `tests/run.js all` gate is ~33 minutes
// in (lane-554, 2026-08-07; previously 2026-07-26 with 39/39 spurious FAILs).
// The pre-flight moves that verdict to second zero and names the exact fix.
//
// WHY FIXTURE TREES. The failure shapes (worktree gitdir-pointer files,
// missing/dangling node_modules, drifted installs) are built as DISPOSABLE
// trees in $TMPDIR — nothing here reads or mutates any real checkout, and the
// real tree being healthy must not make the failure paths untestable.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { mkdtempOwned } = require('../lib/harness-temp.js');
const { pinnedPlaywright, resolvedPlaywright, checkPlaywrightPin,
        checkBrowserPreflight, mainTreeOf } = require('../browser/lib/playwright-pin.cjs');
const { browserPreflight, SUITES, classify } = require('../run.js');

const PIN = '1.61.0';
const DRIFT = '1.61.1';

// A throwaway repo shape: <root>/tests/browser/{package.json, lib/}, plus
// whatever installs/git identity a case needs.
//   git: 'dir' (a clone) | 'worktree' (gitdir-pointer FILE at mainTree)
//   installed:      version planted at tests/browser/node_modules/playwright
//   rootInstalled:  version planted at <root>/node_modules/playwright (the
//                   ancestor install a worktree's resolution falls through to)
//   pin:            the devDependencies.playwright value (default exact PIN)
function makeFixture(root, { git = 'dir', mainTree = null, installed = null,
                             rootInstalled = null, pin = PIN } = {}) {
  const browserDir = path.join(root, 'tests', 'browser');
  fs.mkdirSync(path.join(browserDir, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(browserDir, 'package.json'),
    JSON.stringify({ private: true, devDependencies: { playwright: pin } }));
  if (git === 'dir') fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  else if (git === 'worktree') {
    fs.writeFileSync(path.join(root, '.git'),
      `gitdir: ${path.join(mainTree, '.git', 'worktrees', 'lane-x')}\n`);
  }
  const plant = (dir, version) => {
    const p = path.join(dir, 'node_modules', 'playwright');
    fs.mkdirSync(p, { recursive: true });
    fs.writeFileSync(path.join(p, 'package.json'), JSON.stringify({ name: 'playwright', version }));
  };
  if (installed) plant(browserDir, installed);
  if (rootInstalled) plant(root, rootInstalled);
  return { root, browserDir };
}

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

const tmp = mkdtempOwned('os-pwpin-');
// The env handed to checkBrowserPreflight is always EXPLICIT below, so an
// operator's ambient CC_NO_PLAYWRIGHT_PIN can't silently green the failure
// legs. checkPlaywrightPin (the launch-time throw) reads process.env, so its
// leg strips the variable for its own duration.
const ENV = {};

console.log('== browser install pre-flight (#559) ==');

// ---- precondition: the fixtures decide resolution, not the environment ----
// resolvedPlaywright walks up to /, so an ancestor of $TMPDIR carrying a
// node_modules/playwright would contaminate every "nothing resolvable" leg.
// No sane host has one; if yours does, this names it instead of flaking.
check('precondition: no ambient playwright above $TMPDIR', () => {
  const { browserDir } = makeFixture(path.join(tmp, 'pre'), {});
  assert.strictEqual(resolvedPlaywright(browserDir), null,
    'an ancestor of $TMPDIR has node_modules/playwright — the fixture legs below would be invalid');
});

// ---- happy paths: the gate is unchanged when the install is right ----
check('pinned install in tests/browser/node_modules passes', () => {
  const { browserDir } = makeFixture(path.join(tmp, 'ok'), { installed: PIN });
  assert.strictEqual(checkBrowserPreflight({ browserDir, env: ENV }).ok, true);
});
check('OUTCOME-based: node_modules missing but an ancestor resolves the PINNED version passes', () => {
  // What matters is that the playwright Node will load IS the pinned one —
  // its Chromium is in the per-user cache however it resolved. Fragile but
  // working stays working; the refusal is reserved for runs that would fail.
  const { browserDir } = makeFixture(path.join(tmp, 'amb-ok'), { rootInstalled: PIN });
  assert.strictEqual(checkBrowserPreflight({ browserDir, env: ENV }).ok, true);
});
check('a non-exact pin (caret range) enforces nothing', () => {
  const { browserDir } = makeFixture(path.join(tmp, 'caret'), { pin: '^1.61.0', installed: '1.99.0' });
  assert.strictEqual(checkBrowserPreflight({ browserDir, env: ENV }).ok, true);
});

// ---- THE LANE-554 SHAPE: worktree, no tests/browser/node_modules, drifted
// ---- ancestor install. Must refuse, name the MISSING dir, and give the
// ---- exact symlink command pointing at the main clone's install.
check('worktree + drifted ancestor install REFUSES with the exact ln -s fix', () => {
  const main = makeFixture(path.join(tmp, 'main1'), { installed: PIN });
  const wt = makeFixture(path.join(tmp, 'wt1'),
    { git: 'worktree', mainTree: main.root, rootInstalled: DRIFT });
  const r = checkBrowserPreflight({ browserDir: wt.browserDir, env: ENV });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.nmMissing, true);
  assert.ok(r.message.includes(DRIFT) && r.message.includes(PIN),
    'the refusal must name both versions');
  assert.ok(r.message.includes('MISSING'), 'the refusal must say node_modules is missing');
  const lnLine = `ln -s ${path.join(main.browserDir, 'node_modules')} ${path.join(wt.browserDir, 'node_modules')}`;
  assert.ok(r.message.includes(lnLine), `the exact fix command is absent:\n${r.message}`);
});
check('fresh worktree with NO resolvable playwright also refuses with the symlink fix', () => {
  const main = makeFixture(path.join(tmp, 'main2'), { installed: PIN });
  const wt = makeFixture(path.join(tmp, 'wt2'), { git: 'worktree', mainTree: main.root });
  const r = checkBrowserPreflight({ browserDir: wt.browserDir, env: ENV });
  assert.strictEqual(r.ok, false);
  assert.ok(/no playwright is resolvable/.test(r.message), r.message);
  assert.ok(r.message.includes(`ln -s ${path.join(main.browserDir, 'node_modules')}`), r.message);
});
check('a DANGLING node_modules symlink counts as missing', () => {
  const main = makeFixture(path.join(tmp, 'main3'), { installed: PIN });
  const wt = makeFixture(path.join(tmp, 'wt3'), { git: 'worktree', mainTree: main.root });
  fs.symlinkSync(path.join(tmp, 'nowhere'), path.join(wt.browserDir, 'node_modules'));
  const r = checkBrowserPreflight({ browserDir: wt.browserDir, env: ENV });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.nmMissing, true);
});

// ---- the non-worktree failure shapes keep an honest fix line ----
check('drifted install IN tests/browser/node_modules refuses with the pnpm fix, no symlink talk', () => {
  const { browserDir } = makeFixture(path.join(tmp, 'drift'), { installed: DRIFT });
  const r = checkBrowserPreflight({ browserDir, env: ENV });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.nmMissing, false);
  assert.ok(r.message.includes('pnpm install --frozen-lockfile'));
  assert.ok(!r.message.includes('ln -s'), 'no symlink suggestion when node_modules exists');
});
check('a CLONE (not a worktree) missing node_modules gets the pnpm fix, no ln -s to nowhere', () => {
  const { browserDir } = makeFixture(path.join(tmp, 'clone'), {});
  const r = checkBrowserPreflight({ browserDir, env: ENV });
  assert.strictEqual(r.ok, false);
  assert.ok(r.message.includes('pnpm install --frozen-lockfile'));
  assert.ok(!r.message.includes('ln -s'), 'a clone has no main tree to link to');
});

// ---- the escape hatch: version-only, never existence ----
check('CC_NO_PLAYWRIGHT_PIN=1 skips the version check when a playwright exists', () => {
  const { browserDir } = makeFixture(path.join(tmp, 'hatch1'), { installed: DRIFT });
  const r = checkBrowserPreflight({ browserDir, env: { CC_NO_PLAYWRIGHT_PIN: '1' } });
  assert.strictEqual(r.ok, true);
});
check('CC_NO_PLAYWRIGHT_PIN=1 does NOT excuse a missing playwright', () => {
  const { browserDir } = makeFixture(path.join(tmp, 'hatch2'), {});
  const r = checkBrowserPreflight({ browserDir, env: { CC_NO_PLAYWRIGHT_PIN: '1' } });
  assert.strictEqual(r.ok, false, 'no playwright at all can never be a deliberate sweep run');
});

// ---- the launch-time throw (launchBrowser defense in depth) is unchanged ----
check('checkPlaywrightPin throws on a drifted resolution, silent on a pinned one', () => {
  const had = process.env.CC_NO_PLAYWRIGHT_PIN;
  delete process.env.CC_NO_PLAYWRIGHT_PIN;
  try {
    const bad = makeFixture(path.join(tmp, 'throw'), { installed: DRIFT });
    assert.throws(() => checkPlaywrightPin(bad.browserDir),
      (e) => e.message.includes(DRIFT) && e.message.includes(PIN));
    const good = makeFixture(path.join(tmp, 'nothrow'), { installed: PIN });
    checkPlaywrightPin(good.browserDir);   // must not throw
  } finally { if (had !== undefined) process.env.CC_NO_PLAYWRIGHT_PIN = had; }
});

// ---- the dispatcher's decision function (what tests/run.js main() calls) ----
check('browserPreflight stands down when the sweep is not selected', () => {
  const broken = makeFixture(path.join(tmp, 'disp1'), { installed: DRIFT });
  const r = browserPreflight(['unit', 'host', 'kernel'], broken.browserDir);
  assert.strictEqual(r.ok, true, 'no sweep in the set — nothing to pre-flight');
});
check('browserPreflight refuses a broken tree whenever sweep is in the set', () => {
  const broken = makeFixture(path.join(tmp, 'disp2'), { installed: DRIFT });
  for (const ordered of [['sweep'], ['todos', 'unit', 'sweep']]) {
    const r = browserPreflight(ordered, broken.browserDir);
    assert.strictEqual(r.ok, false, `sweep in [${ordered}] must pre-flight`);
    assert.ok(r.message.includes(DRIFT));
  }
});

// ---- #477: the skip tier is GONE — the pre-flight above is the sweep's ----
// ---- ONLY Playwright handling, and a spawn failure is a hard fail ----
check('no suite in the registry carries `optional` (#477)', () => {
  for (const [name, s] of Object.entries(SUITES)) {
    assert.ok(!('optional' in s),
      `suite '${name}' carries \`optional\` — the skip tier was removed by #477; ` +
      'a soft-failing suite would let a targeted gate exit 0 with that suite never run');
  }
});
check('classify() hard-fails a spawn failure — never a skip (#477)', () => {
  const c = classify({ ms: 5, status: null, signal: null,
                       spawnError: new Error('spawn node ENOENT') });
  assert.strictEqual(c.status, 'fail',
    'a runner that could not launch must be a fail: main() exits 0 unless some result is literally "fail"');
  assert.ok(/could not launch/.test(c.note), c.note);
  const ok = classify({ ms: 5, status: 0, signal: null, spawnError: undefined });
  assert.strictEqual(ok.status, 'pass');
  const bad = classify({ ms: 5, status: 1, signal: null, spawnError: undefined });
  assert.strictEqual(bad.status, 'fail');
});

// ---- #561: a heavy runner's exit 3 is "contended — did not run", never a ----
// ---- plain red, and never anything softer than a literal 'fail' either  ----
check('classify() marks a heavy suite exit 3 contended — status stays literally "fail" (#561)', () => {
  const c = classify({ ms: 5, status: 3, signal: null, spawnError: undefined }, true);
  assert.strictEqual(c.status, 'fail',
    'the status must stay literally "fail": a non-fail status would let a targeted gate exit 0 with the suite never run — the #477 fake green');
  assert.strictEqual(c.reason, 'heavy-lock-contended');
  assert.ok(/DID NOT RUN/.test(c.note), c.note);
  assert.strictEqual(c.exit, 3);
});
check('classify() exit 3 on a NON-heavy suite, and exit 1 on a heavy one, stay plain fails (#561)', () => {
  // Exit 3 is only reserved for the lock in the two heavy runners' exit-code
  // space; a light runner exiting 3 is just a red. And a heavy runner's exit 1
  // is a genuine red — the reason tag must never soften it.
  const light = classify({ ms: 5, status: 3, signal: null, spawnError: undefined }, false);
  assert.strictEqual(light.status, 'fail');
  assert.strictEqual(light.reason, undefined);
  const red = classify({ ms: 5, status: 1, signal: null, spawnError: undefined }, true);
  assert.strictEqual(red.status, 'fail');
  assert.strictEqual(red.reason, undefined);
});
check('exactly the two heavy suites carry heavyLock in the registry (#561)', () => {
  const heavy = Object.entries(SUITES).filter(([, s]) => s.heavyLock).map(([n]) => n).sort();
  assert.deepStrictEqual(heavy, ['kernel', 'sweep'],
    'heavyLock must name exactly the suites that take the host heavy-test lock — ' +
    'a missing entry hides a contended row as a plain red; a spurious one softens a genuine exit-3 red');
});

// ---- the pure helpers ----
check('mainTreeOf: worktree pointer file → the main clone; a clone → null', () => {
  const main = makeFixture(path.join(tmp, 'mt-main'), {});
  const wt = makeFixture(path.join(tmp, 'mt-wt'), { git: 'worktree', mainTree: main.root });
  assert.strictEqual(mainTreeOf(wt.root), main.root);
  assert.strictEqual(mainTreeOf(main.root), null);
  assert.strictEqual(mainTreeOf(path.join(tmp, 'mt-none')), null);
});
check('pinnedPlaywright reads the fixture pin; resolvedPlaywright reports path+version', () => {
  const { browserDir } = makeFixture(path.join(tmp, 'pure'), { installed: PIN });
  assert.strictEqual(pinnedPlaywright(browserDir), PIN);
  const got = resolvedPlaywright(browserDir);
  assert.strictEqual(got.version, PIN);
  assert.ok(got.path.includes(path.join('tests', 'browser', 'node_modules')));
});

// ---- the REAL tree: the two checks may never disagree ----
// Deliberately NOT "this checkout must pass": that would red the Node-only
// host suite on any clone without playwright, coupling it to a browser dep
// the host suite does not use. The durable invariant is agreement — the
// pre-flight refuses exactly what the launch-time assert would throw on,
// plus "no playwright at all" (which the launch path only discovers
// per-member, at import time). True on healthy, drifted, and bare trees.
check('this checkout: pre-flight verdict agrees with the launch-time pin check', () => {
  const had = process.env.CC_NO_PLAYWRIGHT_PIN;
  delete process.env.CC_NO_PLAYWRIGHT_PIN;
  try {
    let launchOk = true;
    try { checkPlaywrightPin(); } catch { launchOk = false; }
    const resolvable = resolvedPlaywright() !== null;
    const r = checkBrowserPreflight({ env: ENV });
    assert.strictEqual(r.ok, launchOk && resolvable,
      `pre-flight ok=${r.ok}, launch-time ok=${launchOk}, resolvable=${resolvable}\n${r.message || ''}`);
  } finally { if (had !== undefined) process.env.CC_NO_PLAYWRIGHT_PIN = had; }
});

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log('\nall ok');
