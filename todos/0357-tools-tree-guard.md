# 0357 — extend the cross-tree guard to the tools/ writers and os/boot.js

- **Status**: open
- **Design**: `tests/lib/tree-guard.js` (landed by todos/0341)

## Goal

todos/0341 landed the cross-tree preflight at the seven top-level TEST runners.
The **writing entry points under `tools/`, and `os/boot.js`, are still
unguarded** — and they are writers, not readers:

- `tools/mkimage.js` bakes a 111 MB system blob into **its own** `os/`;
- `tools/mkpkg.js` writes `dist/packages/` in its own tree;
- `tools/os-drive.js` writes screenshots (the same class of artifact as the
  stray `logs/2026-07-25/*.png` that motivated 0341);
- `tools/win32rc.js` / `win32ports.js` / `mksounds.js` / `mkmpgenhdr.js` all
  emit committed files next to themselves;
- `os/boot.js` re-bakes and installs the image fixture.

So `node ~/git/c-compiler/tools/mkimage.js` from a worktree cwd still silently
rewrites main's blob. With 0341 landed this is *worse* than before in one
specific way: the tree now advertises a cross-tree guard, which reads as
known-and-handled to anyone who does not check which entry points it covers.
That is why it carries a liability-register entry (L45) rather than a TODO.

## Plan

One line per entry point — `require('…/tests/lib/tree-guard.js')
.assertSameTree(__dirname, {label})` — the same shape 0341 used. The work is
not the call, it is **proving the cwd contract** for each:

- `os/boot.js` is spawned by the kernel e2es from **per-test fixture dirs**
  (`tests/kernel/lib/drive.js` `freshImage` → `mkdtempOwned`). If any of those
  spawns leaves cwd outside the tree, a naive guard turns the whole kernel
  suite red. Establish the actual spawn cwds first, then decide whether the
  guard belongs on `boot.js` at all or only on its hand-run path.
- `tools/mkimage.js` is spawned by `tests/lib/image-fixture.js` (inherited cwd)
  and by `tests/serve/test_image_determinism.js` (`cwd: ROOT`). Both look safe;
  verify rather than assume.

## Acceptance

- Every `tools/` entry point that WRITES into its own tree refuses a foreign-cwd
  launch, with the 0341 message and exit code (4 — see `tree-guard.js`'s header
  for why not 3).
- `os/boot.js` either guarded, or its exemption written down with the spawn cwd
  that forces it.
- The kernel + sweep suites green — they are the ones that spawn these, and the
  whole risk in this item is a guard that fires on the harness's own children.
- L45 retired in the same commit.

## Related

- todos/0341 — the guard itself (this is its uncovered remainder).
- todos/0342 — direct test invocation bypasses the heavy lock. Same family
  (a runner launched off the sanctioned path), different resource.
