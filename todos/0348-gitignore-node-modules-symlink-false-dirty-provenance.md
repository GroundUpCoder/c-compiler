# 0348 — `.gitignore` misses `node_modules` SYMLINKS, so the deploy recipe stamps every bundle `-dirty`

- **Status**: open
- **Provenance**: found live by master cont-111 during the **v178 deploy**
  (2026-07-28). Lesson **(BL)** in `~/git/meta/meta/notes/MASTER-LESSONS.md`.
- **Priority**: **P3 — small, self-contained, high clarity-per-byte.** Not a
  product defect; a *provenance-honesty* defect in the release path.
- **Blocked by**: nothing. Touches `.gitignore` only (see "Scope" — do NOT let
  this grow).

## The defect

`.gitignore:6` reads:

    node_modules/

The **trailing slash makes the pattern match directories only**. In the main
tree `node_modules` is a real directory, so it is ignored and
`git status --porcelain` is empty. But the documented deploy recipe creates a
throwaway worktree and links the deps in:

    git worktree add /tmp/deploy-vNNN <sha>
    ln -sfn ~/git/c-compiler/node_modules            /tmp/deploy-vNNN/node_modules
    ln -sfn ~/git/c-compiler/tests/browser/node_modules /tmp/deploy-vNNN/tests/browser/node_modules

A **symlink is a blob, not a directory**, so `node_modules/` does not match it.
Both links land as `??` untracked, and comguc's build cleanliness probe reports:

    [build] ⚠ c-compiler is DIRTY (2 file(s)) — this bundle is not reproducible from a commit alone
    [build] provenance: c-compiler 08e09966-dirty, img e208b42703f9…

## Why it matters — the stamp is false, not merely noisy

`deploys/README.md` prescribes reconstructing a bundle with
`git -C ~/git/c-compiler checkout <commit>` and states it *"must be clean —
`dirty:false`"*. A `dirty:true` stamp therefore tells a future reader the
bundle **cannot** be reproduced from the commit — when in fact it can.

**Proved by positive control at cont-111.** Rebuilding the identical tree with
the two symlinks removed produced:

    [build] provenance: c-compiler 08e09966, img e208b42703f9…

**Byte-identical image hash `e208b427…`; only the attribution changed.** So the
symlinks contribute **zero** content and the dirty flag is pure false positive.

⚠️ This is *not* a long-standing stamp — the v177 deploy (same recipe, same
`/tmp/deploy-vNNN` shape, 2026-07-27) recorded `dirty: false, dirtyFiles: []`
in `deploys/log.jsonl`. The difference is **ordering**: v177 evidently built
before the symlinks existed. That is exactly the hazard — the recipe reads as a
flat list of steps, so its correctness silently depends on an unstated order.

## Fix

Change `.gitignore:6` from `node_modules/` to `node_modules` (no trailing
slash) so the pattern matches the directory **and** the symlink. That makes the
deploy recipe **order-independent** instead of order-critical.

## Acceptance

1. In a fresh deploy worktree with **both** symlinks created **before** the
   build, `git status --porcelain` is **empty**.
2. `C_COMPILER=<that worktree> CLANG_SIMPLIFIED=… pnpm build` in `~/git/comguc`
   prints `provenance: c-compiler <sha>` with **no `-dirty` suffix** and **no**
   `⚠ c-compiler is DIRTY` line.
3. **Positive control** (this is the leg that makes (1)+(2) meaningful — an
   ignore rule that ignores *too much* would also pass them): with an
   unrelated genuine edit in the worktree (e.g. `touch os/SCRATCH && echo x >>
   os/SCRATCH` on a *tracked* file), the build **still** reports DIRTY. The
   rule must silence the symlinks and nothing else.
4. In the **main** tree, `git status --porcelain` remains empty and
   `git check-ignore -v node_modules` still resolves to the `.gitignore` line.

## Scope — keep it one line

Do **not** also rewrite the deploy recipe's step order in this ticket, do
**not** touch `scripts/provenance.mjs`, and do **not** add new ignore entries.
The whole point is that one character of `.gitignore` removes an ordering
constraint. The recipe-order correction is already recorded in lesson (BL) and
in the master handoff; this ticket makes it *unnecessary*.

## Gate

`.gitignore`-only ⇒ **no image bump.** Let the planner name it
(`node tests/run.js --diff <merge-base> --dry-run`); expect `todos` only, since
`.gitignore` maps to no suite. Do not run the heavy suites for this.
