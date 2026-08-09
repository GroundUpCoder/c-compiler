'use strict';
// #614: resolveSiblingRepo — where a sibling definition-source checkout
// (gucos-packages) lives relative to a c-compiler tree. The naive
// `<root>/../<name>` is WRONG from a linked git worktree (it resolves to a
// sibling of the worktree slug, not of the clone), and deploys build from
// exactly such a worktree — so the resolution is ordered and each rule gets
// a leg here:
//   1. env override wins, verbatim, WITHOUT an existence check (an explicit
//      override that is wrong must fail loud at the caller, never silently
//      fall through to a discovered candidate).
//   2. the MAIN clone's sibling, derived from the `.git` gitdir pointer.
//   3. the naive sibling (the main clone IS its own main root).
//   none → null (caller's policy decides whether that is an error).
//
//   node tests/host/test_sibling_resolve.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const COMMON = require(path.join(ROOT, 'os', 'os-common.js'));

let failures = 0;
const check = (name, fn) => {
  try { fn(); console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n         ' + (e.message || e)); failures++; }
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sibresolve-'));
const mk = (rel) => { const p = path.join(tmp, rel); fs.mkdirSync(p, { recursive: true }); return p; };
const w = (rel, text) => {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};

// A fake main clone with its linked worktree, git's real on-disk shapes:
// the main clone's .git is a DIRECTORY; the linked worktree's .git is a
// FILE holding a `gitdir:` pointer at <main>/.git/worktrees/<slug>.
const MAIN = mk('git/c-compiler');
mk('git/c-compiler/.git/worktrees/lane-x');
const SIBLING = mk('git/gucos-packages');
const WT = mk('worktree/c-compiler/lane-x');
w('worktree/c-compiler/lane-x/.git',
  'gitdir: ' + path.join(MAIN, '.git', 'worktrees', 'lane-x') + '\n');

check('main clone resolves its own sibling', () => {
  const r = COMMON.resolveSiblingRepo(fs, path, MAIN, 'gucos-packages', {});
  assert.ok(r, 'expected a resolution, got null');
  assert.strictEqual(r.root, SIBLING);
});

check('a LINKED WORKTREE resolves the MAIN clone\'s sibling (the deploy-box shape)', () => {
  // The naive ../gucos-packages from WT would be worktree/c-compiler/
  // gucos-packages, which does not exist — the gitdir pointer must carry the
  // resolution home.
  const r = COMMON.resolveSiblingRepo(fs, path, WT, 'gucos-packages', {});
  assert.ok(r, 'expected a resolution, got null');
  assert.strictEqual(r.root, SIBLING,
    'a worktree must resolve the main clone\'s sibling, got ' + r.root);
  assert.strictEqual(r.via, 'main-clone sibling');
});

check('a RELATIVE gitdir pointer resolves too', () => {
  const WT2 = mk('worktree/c-compiler/lane-y');
  mk('git/c-compiler/.git/worktrees/lane-y');
  w('worktree/c-compiler/lane-y/.git',
    'gitdir: ../../../git/c-compiler/.git/worktrees/lane-y\n');
  const r = COMMON.resolveSiblingRepo(fs, path, WT2, 'gucos-packages', {});
  assert.ok(r && r.root === SIBLING, 'got ' + JSON.stringify(r));
});

check('worktree falls back to the naive sibling when the main-clone sibling is absent', () => {
  const MAIN2 = mk('elsewhere/c-compiler');
  mk('elsewhere/c-compiler/.git/worktrees/lane-z');
  const WT3 = mk('wt2/c-compiler/lane-z');
  w('wt2/c-compiler/lane-z/.git',
    'gitdir: ' + path.join(MAIN2, '.git', 'worktrees', 'lane-z') + '\n');
  const NAIVE = mk('wt2/c-compiler/gucos-packages');   // only the naive candidate exists
  const r = COMMON.resolveSiblingRepo(fs, path, WT3, 'gucos-packages', {});
  assert.ok(r && r.root === NAIVE, 'got ' + JSON.stringify(r));
  assert.strictEqual(r.via, 'sibling');
});

check('a non-git tree uses the naive sibling', () => {
  const BARE = mk('bare/tree');
  const NAIVE = mk('bare/gucos-packages');
  const r = COMMON.resolveSiblingRepo(fs, path, BARE, 'gucos-packages', {});
  assert.ok(r && r.root === NAIVE, 'got ' + JSON.stringify(r));
});

check('env override wins over every discovered candidate', () => {
  const OVERRIDE = mk('override/gucos-packages');
  const r = COMMON.resolveSiblingRepo(fs, path, MAIN, 'gucos-packages', { env: OVERRIDE });
  assert.ok(r && r.root === OVERRIDE && r.via === 'env', 'got ' + JSON.stringify(r));
});

check('env override is returned even when it does not exist (the caller fails loud)', () => {
  // An explicit override must never silently fall through to a discovered
  // candidate — the cmdalt no-silent-fallback rule.
  const gone = path.join(tmp, 'no-such-dir');
  const r = COMMON.resolveSiblingRepo(fs, path, MAIN, 'gucos-packages', { env: gone });
  assert.ok(r && r.root === gone && r.via === 'env', 'got ' + JSON.stringify(r));
});

check('no candidate anywhere → null', () => {
  const LONE = mk('lonely/deep/tree');
  const r = COMMON.resolveSiblingRepo(fs, path, LONE, 'gucos-packages', {});
  assert.strictEqual(r, null);
});

check('the REAL worktree/main-clone pair resolves coherently', () => {
  // Whatever tree this test runs in (main clone or a linked worktree), the
  // resolution must land on an existing directory or null — never a path
  // that does not exist (only the env override may do that).
  const r = COMMON.resolveSiblingRepo(fs, path, ROOT, 'gucos-packages', {});
  if (r !== null) assert.ok(fs.existsSync(r.root), r.root + ' does not exist');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? failures + ' check(s) FAILED' : 'sibling resolution OK');
process.exit(failures ? 1 : 0);
