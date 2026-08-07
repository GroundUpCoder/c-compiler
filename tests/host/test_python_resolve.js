'use strict';
// tests/host/test_python_resolve.js — the pinned host-python resolver (#483),
// failure paths exercised on every run (the test_browser_preflight.js
// pattern: a guard whose failure path was never exercised is not a guard).
//
// THE INCIDENT CLASS THIS PINS. tests/run.js used to spawn `python3` by $PATH
// lookup — system Python 3.9 on this machine — so the gate's py leg (19 of 26
// suites) rode an ambient property of whoever's shell launched the runner,
// and an interpreter fault presented as a tree fault. The resolver
// (tools/host-python.js) ends that: $PYTHON override → this tree's .venv →
// the main clone's .venv (worktree read-through) → refusal naming the exact
// fix. NEVER $PATH.
//
// WHY FIXTURE TREES. The failure shapes (missing venv, dangling interpreter,
// version drift, worktree gitdir-pointers, dead overrides) are built as
// DISPOSABLE trees in $TMPDIR — the real tree being healthy must not make the
// failure paths untestable. The one deliberate exception is the integration
// leg at the bottom, which resolves THIS tree and really launches the result.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { mkdtempOwned } = require('../lib/harness-temp.js');
const { resolvePython, pinnedPython, venvPythonVersion, venvInterpreter,
        versionMatchesPin } = require('../../tools/host-python.js');
const { pythonPreflight } = require('../run.js');

const ROOT = path.resolve(__dirname, '..', '..');

// A throwaway repo shape: <root>/{.python-version, .venv/, .git}.
//   git: 'dir' (a clone) | 'worktree' (gitdir-pointer FILE at mainTree)
//   venv: { version } plants .venv/pyvenv.cfg (uv's version_info key) and an
//         executable .venv/bin/python; { broken: true } plants the dir with
//         no interpreter (the dangling-base-interpreter shape)
//   pin:  the .python-version content (null → no pin file)
function makeFixture(root, { git = 'dir', mainTree = null, venv = null, pin = '3.12' } = {}) {
  fs.mkdirSync(root, { recursive: true });
  if (pin != null) fs.writeFileSync(path.join(root, '.python-version'), pin + '\n');
  if (git === 'dir') fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  else if (git === 'worktree') {
    fs.writeFileSync(path.join(root, '.git'),
      `gitdir: ${path.join(mainTree, '.git', 'worktrees', 'lane-x')}\n`);
  }
  if (venv) {
    const vdir = path.join(root, '.venv');
    fs.mkdirSync(path.join(vdir, 'bin'), { recursive: true });
    if (!venv.broken) {
      fs.writeFileSync(path.join(vdir, 'pyvenv.cfg'),
        `home = /nonexistent\nversion_info = ${venv.version}\n`);
      fs.writeFileSync(path.join(vdir, 'bin', 'python'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
  }
  return root;
}

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

const tmp = mkdtempOwned('os-hostpy-');
// Every resolvePython call below hands env EXPLICITLY, so an operator's
// ambient $PYTHON can't silently reroute the fixture legs.
const ENV = {};

console.log('== host-python resolver (#483) ==');

// ---- the semantic core: no $PATH fallthrough, ever ----
// This machine HAS a python3 on $PATH (that ambient fact is what makes this
// leg semantic rather than vacuous): with no override and no venv anywhere,
// resolution must REFUSE — a resolver that "helpfully" found the system
// python would pass every other leg and reintroduce the exact bug.
check('no venv + no override REFUSES despite an ambient $PATH python3', () => {
  const root = makeFixture(path.join(tmp, 'bare'), {});
  const r = resolvePython({ root, env: ENV });
  assert.strictEqual(r.ok, false);
  assert.ok(/uv venv/.test(r.message), 'refusal must name the uv venv fix');
});

check('healthy venv resolves to ITS interpreter, loose-pin match (3.12 vs 3.12.13)', () => {
  const root = makeFixture(path.join(tmp, 'ok'), { venv: { version: '3.12.13' } });
  const r = resolvePython({ root, env: ENV });
  assert.strictEqual(r.ok, true, r.message);
  assert.strictEqual(r.python, path.join(root, '.venv', 'bin', 'python'));
  assert.strictEqual(r.source, 'venv');
});

check('$PYTHON override wins over a healthy venv, used verbatim', () => {
  const root = makeFixture(path.join(tmp, 'ovr'), { venv: { version: '3.12.13' } });
  const alt = path.join(tmp, 'alt-python');
  fs.writeFileSync(alt, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const r = resolvePython({ root, env: { PYTHON: alt } });
  assert.strictEqual(r.ok, true, r.message);
  assert.strictEqual(r.python, alt);
});

check('a dead $PYTHON override REFUSES — never falls through to the healthy venv', () => {
  const root = makeFixture(path.join(tmp, 'ovrdead'), { venv: { version: '3.12.13' } });
  const r = resolvePython({ root, env: { PYTHON: path.join(tmp, 'no-such-python') } });
  assert.strictEqual(r.ok, false, 'override must not be silently substituted');
  assert.ok(r.message.includes('no-such-python'), 'refusal must name the dead override');
});

check('version drift REFUSES naming uv venv --clear (the system-python-in-a-venv shape)', () => {
  const root = makeFixture(path.join(tmp, 'drift'), { venv: { version: '3.9.6' } });
  const r = resolvePython({ root, env: ENV });
  assert.strictEqual(r.ok, false, 'a 3.9 venv under a 3.12 pin must refuse');
  assert.ok(/3\.9\.6/.test(r.message) && /3\.12/.test(r.message), 'refusal names both versions');
  assert.ok(/--clear/.test(r.message), 'refusal names the recreate command');
});

check('a present-but-broken .venv REFUSES — claims the slot, never routed around', () => {
  const root = makeFixture(path.join(tmp, 'broken'), { venv: { broken: true } });
  const r = resolvePython({ root, env: ENV });
  assert.strictEqual(r.ok, false);
  assert.ok(/--clear/.test(r.message), 'refusal names the recreate command');
});

check('no pin file → venv accepted regardless of version (nothing to enforce)', () => {
  const root = makeFixture(path.join(tmp, 'nopin'), { pin: null, venv: { version: '3.9.6' } });
  const r = resolvePython({ root, env: ENV });
  assert.strictEqual(r.ok, true, r.message);
});

check('worktree read-through: a bare worktree resolves the main clone\'s .venv', () => {
  const mainTree = makeFixture(path.join(tmp, 'wt-main'), { venv: { version: '3.12.13' } });
  const wt = makeFixture(path.join(tmp, 'wt-lane'), { git: 'worktree', mainTree });
  const r = resolvePython({ root: wt, env: ENV });
  assert.strictEqual(r.ok, true, r.message);
  assert.strictEqual(r.python, path.join(mainTree, '.venv', 'bin', 'python'));
  assert.strictEqual(r.source, 'main-tree venv');
});

check('worktree with NO venv anywhere: refusal names the MAIN tree\'s uv venv command', () => {
  const mainTree = makeFixture(path.join(tmp, 'wt2-main'), {});
  const wt = makeFixture(path.join(tmp, 'wt2-lane'), { git: 'worktree', mainTree });
  const r = resolvePython({ root: wt, env: ENV });
  assert.strictEqual(r.ok, false);
  assert.ok(r.message.includes(`cd ${mainTree} && uv venv`),
    'the one-command-fixes-every-worktree line must point at the main clone');
});

check('a worktree\'s OWN .venv outranks the main clone\'s (explicit beats read-through)', () => {
  const mainTree = makeFixture(path.join(tmp, 'wt3-main'), { venv: { version: '3.12.13' } });
  const wt = makeFixture(path.join(tmp, 'wt3-lane'),
    { git: 'worktree', mainTree, venv: { version: '3.12.13' } });
  const r = resolvePython({ root: wt, env: ENV });
  assert.strictEqual(r.ok, true, r.message);
  assert.strictEqual(r.python, path.join(wt, '.venv', 'bin', 'python'));
});

// ---- the dispatcher glue (the browserPreflight testing precedent) ----
check('pythonPreflight skips when no run.py-backed suite is selected', () => {
  const r = pythonPreflight(['host', 'kernel', 'sweep']);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.skipped, true);
});

check('pythonPreflight refuses (message-bearing) for a py suite on a bare tree', () => {
  const root = makeFixture(path.join(tmp, 'glue'), {});
  const r = pythonPreflight(['disw'], { root, env: ENV });
  assert.strictEqual(r.ok, false);
  assert.ok(r.message && /uv venv/.test(r.message));
});

// ---- unit seams ----
check('versionMatchesPin: major.minor prefix semantics, no substring accidents', () => {
  assert.ok(versionMatchesPin('3.12.13', '3.12'));
  assert.ok(versionMatchesPin('3.12', '3.12'));
  assert.ok(!versionMatchesPin('3.9.6', '3.12'));
  assert.ok(!versionMatchesPin('3.120.1', '3.12'));
  assert.ok(versionMatchesPin('3.12.13', '3.12.13'));
});

check('pinnedPython/venvPythonVersion read the real files (stdlib `version =` key too)', () => {
  const root = makeFixture(path.join(tmp, 'keys'), { venv: { version: '3.12.13' } });
  assert.strictEqual(pinnedPython(root), '3.12');
  assert.strictEqual(venvPythonVersion(path.join(root, '.venv')), '3.12.13');
  fs.writeFileSync(path.join(root, '.venv', 'pyvenv.cfg'), 'version = 3.11.4\n');
  assert.strictEqual(venvPythonVersion(path.join(root, '.venv')), '3.11.4');
});

// ---- integration: THIS tree resolves, and the result is a real python of
// the pinned version. A tree without its venv fails here WITH the resolver's
// own fix-naming message — that red is the diagnosis, not a flake (§ never a
// downstream mystery, todos/0171).
check('this tree resolves to a working interpreter matching .python-version', () => {
  const r = resolvePython({ env: ENV });
  assert.strictEqual(r.ok, true, r.ok ? '' : '\n' + r.message);
  const pin = pinnedPython(ROOT);
  assert.ok(pin, '.python-version must exist at the repo root');
  const probe = spawnSync(r.python,
    ['-c', 'import sys; print("%d.%d" % sys.version_info[:2])'],
    { encoding: 'utf8' });
  assert.strictEqual(probe.status, 0, probe.stderr || 'interpreter did not run');
  const got = probe.stdout.trim();
  assert.strictEqual(got, pin.split('.').slice(0, 2).join('.'),
    `resolved interpreter ${got} != pinned major.minor ${pin}`);
});

if (failures) { console.log(`\n${failures} FAILED`); process.exit(1); }
console.log('\nall ok');
