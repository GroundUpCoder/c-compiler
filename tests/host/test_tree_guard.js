'use strict';
// tests/host/test_tree_guard.js — the POSITIVE CONTROL for the cross-tree
// preflight (todos/0341), made durable. "A guard whose failure path was never
// exercised is not a guard", so the refusal is exercised here on every run, not
// just once by hand at landing time.
//
// WHY IT BUILDS ITS OWN TREES. The obvious control — "launch the main-tree copy
// from a worktree cwd and watch it exit" — IS the bug: the main-tree copy does
// not carry this guard until the branch lands, so performing it would be one
// more unguarded cross-tree write into a repo three lanes are working in. So
// the control is constructed from DISPOSABLE trees in $TMPDIR instead: a real
// copy of tree-guard.js plus a two-line stub harness in tree A, launched with
// cwd in tree B. Nothing here touches any real checkout.
//
// The trees are marked with a bare `.git` entry rather than `git init` on
// purpose: `.git` is exactly the input the guard reads, and both real shapes
// are covered — a DIRECTORY (a clone) and a gitdir-pointer FILE (what `git
// worktree add` leaves), which is the shape every lane in this fleet runs in.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { mkdtempOwned } = require('../lib/harness-temp.js');
const { ESCAPE, EXIT_CROSS_TREE, treeRootOf, checkTree } = require('../lib/tree-guard.js');

const GUARD_SRC = path.join(__dirname, '..', 'lib', 'tree-guard.js');

// A throwaway tree: <root>/tests/lib/tree-guard.js + <root>/tests/harness.js,
// where harness.js is the stub top-level runner that calls the preflight the
// way every real runner now does.
function makeTree(root, { git = 'dir' } = {}) {
  fs.mkdirSync(path.join(root, 'tests', 'lib'), { recursive: true });
  if (git === 'dir') fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  else if (git === 'file') fs.writeFileSync(path.join(root, '.git'), 'gitdir: /nowhere/worktrees/x\n');
  // git === 'none' -> not a git tree at all
  fs.copyFileSync(GUARD_SRC, path.join(root, 'tests', 'lib', 'tree-guard.js'));
  fs.writeFileSync(path.join(root, 'tests', 'harness.js'),
    "require('./lib/tree-guard.js').assertSameTree(__dirname, { label: 'stub' });\n" +
    "process.stdout.write('HARNESS RAN\\n');\n");
  return root;
}

function launch(treeRoot, cwd, env = {}) {
  const r = spawnSync(process.execPath, [path.join(treeRoot, 'tests', 'harness.js')],
    { cwd, encoding: 'utf-8', env: { ...process.env, [ESCAPE]: '', ...env } });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}\n       ${e.message}`); }
}

const tmp = mkdtempOwned('os-treeguard-');
const A = makeTree(path.join(tmp, 'treeA'), { git: 'dir' });          // a clone
const B = makeTree(path.join(tmp, 'treeB'), { git: 'file' });         // a worktree
const C = path.join(tmp, 'plain'); fs.mkdirSync(C, { recursive: true }); // no .git anywhere
const NESTED = makeTree(path.join(A, 'nested'), { git: 'file' });     // a worktree INSIDE A
const X = makeTree(path.join(tmp, 'treeX'), { git: 'none' });         // an export, no .git

console.log('== cross-tree preflight (todos/0341) ==');

// ---- THE POSITIVE CONTROL: tree A's harness, launched from tree B's cwd ----
check('cross-tree launch is REFUSED', () => {
  const r = launch(A, B);
  assert.strictEqual(r.status, EXIT_CROSS_TREE, `expected exit ${EXIT_CROSS_TREE}, got ${r.status}`);
  assert.ok(!r.out.includes('HARNESS RAN'), 'the harness body must not have run');
});
check('the refusal prints BOTH trees', () => {
  const r = launch(A, B);
  assert.ok(r.err.includes(fs.realpathSync(A)), 'script tree missing from the message');
  assert.ok(r.err.includes(fs.realpathSync(B)), 'cwd tree missing from the message');
});
check('the refusal names the escape hatch', () => {
  assert.ok(launch(A, B).err.includes(ESCAPE), `message must name ${ESCAPE}`);
});
// The adjudication, pinned: exit 3 is heavy-lock contention (tests/lib/
// heavy-lock.js) in the very runners this guard fronts, and the fleet reads a
// bare 3 as benign. A cross-tree write must never wear that code.
check('the exit code is NOT 3 (the heavy-lock code)', () => {
  assert.notStrictEqual(launch(A, B).status, 3);
});

// ---- THE NEGATIVE CONTROL: the happy path is untouched ----
check('same-tree launch runs normally', () => {
  const r = launch(A, A);
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}: ${r.err}`);
  assert.ok(r.out.includes('HARNESS RAN'), 'the harness body must run');
  assert.strictEqual(r.err, '', `the happy path must be silent, got: ${r.err}`);
});
check('a SUBDIRECTORY of the right tree runs normally', () => {
  const sub = path.join(A, 'tests', 'lib');
  const r = launch(A, sub);
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}: ${r.err}`);
  assert.ok(r.out.includes('HARNESS RAN'));
});

// ---- the cases plain path-containment would get wrong ----
check('a nested worktree inside the tree is still caught', () => {
  // NESTED is physically under A, so "is cwd below root?" would wave it
  // through; it is a different git tree and must not be.
  const r = launch(A, NESTED);
  assert.strictEqual(r.status, EXIT_CROSS_TREE, `expected exit ${EXIT_CROSS_TREE}, got ${r.status}`);
  assert.ok(r.err.includes(fs.realpathSync(NESTED)), 'nested tree missing from the message');
});
check('a cwd in no git tree at all is refused, and says so', () => {
  const r = launch(A, C);
  assert.strictEqual(r.status, EXIT_CROSS_TREE, `expected exit ${EXIT_CROSS_TREE}, got ${r.status}`);
  assert.ok(/cwd is not inside a git tree/.test(r.err), `message should say so, got: ${r.err}`);
});
check('a script tree with no .git stands down (export/tarball)', () => {
  const r = launch(X, C);
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}: ${r.err}`);
  assert.ok(r.out.includes('HARNESS RAN'));
});

// ---- the escape hatch: explicit, per-invocation, and never silent ----
check(`${ESCAPE}=1 continues but STILL prints both paths`, () => {
  const r = launch(A, B, { [ESCAPE]: '1' });
  assert.strictEqual(r.status, 0, `expected exit 0, got ${r.status}: ${r.err}`);
  assert.ok(r.out.includes('HARNESS RAN'), 'the harness body must run under the hatch');
  assert.ok(r.err.includes(fs.realpathSync(A)) && r.err.includes(fs.realpathSync(B)),
    'the hatch must not go quiet — both paths still printed');
});
check(`${ESCAPE}=0 does NOT open the hatch`, () => {
  assert.strictEqual(launch(A, B, { [ESCAPE]: '0' }).status, EXIT_CROSS_TREE);
});

// ---- the pure decision logic, directly ----
check('treeRootOf walks up to the nearest .git', () => {
  assert.strictEqual(treeRootOf(path.join(A, 'tests', 'lib')), fs.realpathSync(A));
  assert.strictEqual(treeRootOf(NESTED), fs.realpathSync(NESTED));
  assert.strictEqual(treeRootOf(C), null);
});
check('checkTree is pure and reports both trees', () => {
  const bad = checkTree(path.join(A, 'tests'), B);
  assert.strictEqual(bad.ok, false);
  assert.strictEqual(bad.scriptTree, fs.realpathSync(A));
  assert.strictEqual(bad.cwdTree, fs.realpathSync(B));
  assert.strictEqual(checkTree(path.join(A, 'tests'), A).ok, true);
});
// This repo's own harness must be launchable from its own root — the guard is
// only useful if it is silent where it should be.
check('this checkout passes its own guard', () => {
  assert.strictEqual(checkTree(__dirname, path.resolve(__dirname, '..', '..')).ok, true);
});

console.log(failures ? `\n${failures} tree-guard check(s) FAILED` : '\nAll tree-guard checks passed');
process.exit(failures ? 1 : 0);
