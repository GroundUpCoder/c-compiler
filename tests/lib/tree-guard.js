'use strict';
// tests/lib/tree-guard.js — the harness's CROSS-TREE preflight (todos/0341):
// refuse to run a harness copy that lives in a DIFFERENT git tree than the cwd
// it was launched from.
//
// WHY THIS EXISTS. Every script under tests/ + tools/ resolves the repo root
// from its OWN location — `path.resolve(__dirname, '../..')`, 127 sites — and
// reads and writes THERE. In isolation that convention is correct: a script
// writing next to itself is exactly what you want, and the suite is almost
// perfectly cwd-independent by design. The consequence is the trap:
//
//   The tree you write to is decided by WHICH PHYSICAL COPY of the script you
//   execute. `cd` into your worktree is NOT the control and cannot protect you.
//
// A lane with perfect cwd discipline that types `node ~/git/c-compiler/tests/…`
// — or copies one absolute path out of a doc, a wrapper, or a kickoff line —
// writes into MAIN, silently, from any cwd. That is how two stray PNGs landed
// in ~/git/c-compiler from a lane working in ~/worktree/c-compiler/fix-0316
// (the dated artifact behind todos/0341), and it has happened more than once.
//
// So the fix is the missing CHECK, not a change to the resolution: assert the
// script's tree and the cwd's tree are the same git tree, and fail loud if not.
// Because every one of the 127 sites funnels through the same handful of
// launches, guarding the launch guards all of them at once.
//
// WHAT "SAME TREE" MEANS HERE. The nearest ancestor directory holding a `.git`
// entry, realpath'd. That is exact for the layout this fleet actually uses —
// a main clone plus N `git worktree` siblings, where `.git` is a dir in the
// clone and a gitdir-pointer FILE in each worktree — and it costs no
// subprocess. Two properties that matter:
//   - cwd in a SUBDIRECTORY of the right tree passes (it walks up);
//   - a worktree nested inside another tree is still caught (nearest wins),
//     which plain path-containment would wave through.
// If the script's own tree has no `.git` at all (a tarball export, a vendored
// copy), tree identity is not establishable and the guard stands down rather
// than inventing a failure.
//
// EXIT CODE — 4, DELIBERATELY NOT the 3 the ticket asked for. Exit 3 already
// means "another heavy suite holds the lock, wait and retry" (tests/lib/
// heavy-lock.js) — and it means that in tests/kernel/run.js and
// tests/browser/os-sweep.mjs, two of the very runners this guard sits at the
// top of. The whole fleet is trained to read a bare 3 from those runners as
// benign contention. Reusing it would disguise a cross-tree write as the one
// exit code everybody has learned to ignore, which inverts the point of the
// ticket. 4 is unused across tests/ + tools/ (3 also appears on a few browser
// probe watchdogs, so it is doubly spoken for).

// SCOPE — the seven top-level TEST runners (tests/run.js, run-unit.js,
// flake.js, blockfs/kernel/host/todos run.js, browser/os-sweep.mjs), and —
// since #142 (todos/0357) — the writing entry points: os/boot.js and the
// tools/ writers (mkimage.js, mkpkg.js, os-drive.mjs + os-drive-headless.mjs,
// win32rc.js, win32ports.js, mksounds.js, mkmpgenhdr.js, build-libc-ext.js,
// mkgif.js, mkwebfixtures.js, mkgit2srclib.js; libcprobe/probe.js opted in
// earlier). The #142 survey measured every harness spawn of those entry
// points before guarding them: suite-runner children run with cwd inside the
// tree (tests/kernel, tests/browser), the host/serve rows inherit the
// dispatcher's repo-root cwd, run.py sets cwd=ROOT_DIR, and the per-test
// mkdtemp fixture dirs are only ever --image=/--out= ARGUMENTS, never cwds —
// so the guard fires on foreign-cwd hand launches and on nothing else.
const fs = require('fs');
const path = require('path');

// Explicit, per-invocation, and never silent: an override still prints both
// paths. Unlike CC_NO_HEAVY_LOCK it cannot manufacture a quiet green.
const ESCAPE = 'CC_ALLOW_FOREIGN_CWD';
const EXIT_CROSS_TREE = 4;

function realOrResolve(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

// Nearest ancestor of `dir` (inclusive) holding a `.git` entry — dir for a
// clone, file for a `git worktree` checkout. null when there is none.
function treeRootOf(dir) {
  let d = realOrResolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

// Pure decision logic, so the failure path is unit-testable without a process
// exit (tests/host/test_tree_guard.js). Returns {ok} or {ok:false, …paths}.
function checkTree(scriptDir, cwd) {
  const scriptTree = treeRootOf(scriptDir);
  if (!scriptTree) return { ok: true, reason: 'script tree is not a git tree — nothing to compare' };
  const cwdReal = realOrResolve(cwd);
  const cwdTree = treeRootOf(cwdReal);
  if (cwdTree === scriptTree) return { ok: true, scriptTree, cwdTree, cwd: cwdReal };
  return { ok: false, scriptTree, cwdTree, cwd: cwdReal };
}

function message(r, label) {
  const who = label ? `${label} ` : '';
  return '\n\x1b[1m\x1b[31m━━━ cross-tree launch REFUSED (todos/0341) ━━━\x1b[0m\n'
    + `  script tree : ${r.scriptTree}\n`
    + `  cwd tree    : ${r.cwdTree || '(none — cwd is not inside a git tree)'}\n`
    + `  cwd         : ${r.cwd}\n\n`
    + `  This ${who}harness copy lives in the FIRST tree and resolves every path from\n`
    + '  its own location, so the run would read and WRITE there — not where you are.\n'
    + '  `cd` is not the control: re-launch the copy that lives in the tree you mean.\n\n'
    + (r.cwdTree ? `    cd ${r.cwdTree} && node <the same script, relative>\n\n` : '')
    + `  Deliberate cross-tree run? Set ${ESCAPE}=1 on THIS invocation. It still\n`
    + '  prints both paths — the guard never goes quiet, it only stops refusing.\n\n';
}

// The ~5-line preflight every top-level runner calls first. `scriptDir` is the
// caller's own __dirname (any path inside its tree); the tree is derived here.
function assertSameTree(scriptDir, { label = null, log = (m) => process.stderr.write(m) } = {}) {
  const r = checkTree(scriptDir, process.cwd());
  if (r.ok) return r;
  log(message(r, label));
  if (process.env[ESCAPE] === '1') {
    log(`  \x1b[1m${ESCAPE}=1 is set — continuing anyway.\x1b[0m\n\n`);
    return r;
  }
  process.exit(EXIT_CROSS_TREE);
}

module.exports = { assertSameTree, checkTree, treeRootOf, message, ESCAPE, EXIT_CROSS_TREE };

// `node tests/lib/tree-guard.js` — report the verdict for this copy by hand.
if (require.main === module) {
  const r = checkTree(__dirname, process.cwd());
  if (r.ok) {
    process.stdout.write(`tree-guard: OK — script tree and cwd are the same git tree\n  ${r.scriptTree || '(not a git tree)'}\n`);
  } else {
    process.stderr.write(message(r, 'tree-guard'));
    process.exit(EXIT_CROSS_TREE);
  }
}
