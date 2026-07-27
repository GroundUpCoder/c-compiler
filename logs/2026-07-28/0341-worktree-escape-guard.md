# 0341 — the cross-tree preflight: making "cd into your worktree" enforceable

**Ticket**: `todos/0341`. **Branch**: `0341-wtguard`. **Follow-up filed**: `todos/0357` + `L45`.

## What landed

`tests/lib/tree-guard.js` — one shared preflight, called once from each of the
seven top-level test runners:

```
tests/run.js  tests/run-unit.js  tests/flake.js
tests/blockfs/run.js  tests/kernel/run.js  tests/host/run.js  tests/todos/run.js
tests/browser/os-sweep.mjs
```

`assertSameTree(__dirname)` derives the script's git tree (nearest ancestor
holding a `.git` entry, realpath'd) and the cwd's, and refuses when they differ:
both paths printed, the escape hatch named, **exit 4**.

The 127 `path.resolve(__dirname, '../..')` sites are untouched, deliberately.
In isolation that convention is *right* — a script writing next to itself is what
you want — and the ticket says so. The defect was never the resolution; it was
that nothing compared the answer to where the human thought they were.

## Three things the investigation turned up that the ticket did not have

**1. `tests/run.js` erases the evidence for everything downstream.** `runProcess`
(`tests/run.js:486`) spawns every sub-runner with `cwd: ROOT` — and
`tests/todos/run.js:41` and `tests/flake.js:106` do the same for their legs. So
launch the main-tree copy of `tests/run.js` from a worktree and each child is
handed a cwd inside *the script's* tree: from the inside, every one of them looks
perfectly well-behaved. A guard placed only in the suite runners would never fire
on a dispatched run. This is why the check has to sit at the **outermost** launch,
and why `tests/run.js` and `tests/flake.js` are guarded in their own right rather
than being covered by the engine.

**2. "same git tree" is not "cwd is under ROOT".** Plain containment waves through
a worktree nested inside another tree — which is not hypothetical here, since
`git worktree add` accepts any path. Walking to the nearest `.git` costs the same,
handles cwd-in-a-subdirectory for free, and gets the nested case right. Pinned by
a test (`a nested worktree inside the tree is still caught`).

**3. The guard has to stand down where identity is not establishable.** A tree
with no `.git` at all (a tarball export, a vendored copy) cannot be compared, so
the guard returns OK rather than inventing a failure. Also pinned.

## Exit code: 4, not the 3 the ticket asked for

`exit 3` already means *"another heavy suite holds the lock — wait and retry"*
(`tests/lib/heavy-lock.js:87`), and it means that **in `tests/kernel/run.js` and
`tests/browser/os-sweep.mjs`**, two of the runners this guard now fronts. The
whole fleet is trained to read a bare 3 from those two as benign contention.
Reusing it would have dressed a cross-tree write in the one exit code everybody
has learned to ignore — the exact inversion of what the ticket is for. 4 is
unused across `tests/` + `tools/` (3 is doubly spoken for: it is also the
watchdog code on three browser probes). A test asserts the code is **not** 3, so
the adjudication is a contract and not a comment.

## The positive control, and why it is not the one the ticket describes

Acceptance asked to *"launch a main-tree copy from a worktree cwd and show the
guard exits 3."* Read literally that is the bug: the main-tree copy does not
carry the guard until this branch lands, so performing it would have been one
more unguarded cross-tree write into a repo three other lanes are working in.

So the control is built from **disposable trees** instead, and made durable as
`tests/host/test_tree_guard.js` (the `test_harness_leaks.js` precedent — pure
decision logic plus real spawns): trees in `$TMPDIR` carrying a real copy of
`tree-guard.js` and a two-line stub runner, one marked with a `.git` **directory**
(a clone) and one with a gitdir-pointer **file** (what `git worktree add` leaves —
the shape every lane runs in). 14 checks: the refusal, both paths present, the
hatch named, not-exit-3, the happy path silent, subdirectory cwd, nested
worktree, no-git cwd, no-git script tree, hatch on/off, and the pure predicates.
A guard whose failure path is only exercised once at landing is not a guard.

Separately, end-to-end against the **real** entry points: a second throwaway
worktree (`0341-ctrl`, detached at this branch) was launched from this
worktree's cwd. Nothing in `~/git/c-compiler` was read, written, or executed at
any point in this work.

## The escape hatch

`CC_ALLOW_FOREIGN_CWD=1`, per invocation, named in the failure message. It is
deliberately *not* another `CC_NO_HEAVY_LOCK`: when it is set on a mismatch the
guard **still prints both trees** and only then continues. It can excuse a
cross-tree run; it cannot make one quiet.

## What is still uncovered

The `tools/` writers (`mkimage.js` bakes 111 MB into its own `os/`, `mkpkg.js`,
`os-drive.js`, …) and `os/boot.js`. That is sequencing, not oversight: those are
spawned by the harness with cwds this guard has not been proven against —
`os/boot.js` in particular runs from per-test fixture dirs — so extending it
needs the kernel suite to say so. `todos/0357` funds it; `L45` keeps the tree
from reading as if the guard were complete.
