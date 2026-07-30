# 0438 — the browser sweep dirties the tree: os-hires.mjs regenerates a committed PNG on every run

- **Status**: open
- **Design**: —
- **Provenance**: found by the coordinator on 2026-07-30 while reading the todos/0342
  lane's worktree to judge its gate. The lane's tree showed
  ` M logs/2026-07-25/hires-after-05x.png` plus an untracked
  `logs/2026-07-25/hires-before-1x.png` after a clean 42/42 sweep. The 0342 lane
  reported "sweep-churned PNGs restored per the standing note" — so lanes are already
  paying a manual restore step for this.

## Goal

A gate run must not mutate tracked state. `node tests/browser/os-sweep.mjs` must leave a
clean tree clean.

## The gap

`tests/browser/os-hires.mjs` writes its before/after screenshots into a **committed**
directory:

    tests/browser/os-hires.mjs:44   const OUT_DIR = path.resolve(__dirname, '../../logs/2026-07-25');
    tests/browser/os-hires.mjs:126  const beforePath = await snapshot(page, 'hires-before-1x.png');
    tests/browser/os-hires.mjs:185  const afterPath  = await snapshot(page, 'hires-after-05x.png');

`logs/2026-07-25/hires-after-05x.png` is tracked (committed by `43801279`, the
image-v162 hires-display work), and the PNG bytes are not reproducible run to run. So
**every full browser sweep leaves the tree dirty**:

- `hires-after-05x.png` comes back ` M` — a modified committed artifact;
- `hires-before-1x.png` comes back untracked, because the committed sibling is
  `hires-before-2x.png` — a **different name**. The 1x variant was never committed, so
  the test emits a permanent stray.

Writing to the dev-log dir is **deliberate**. `os-hires.mjs:35-36` states the intent:
"before/after screenshots at the pane's display size land in the dev log dir (the
artifact jku sees)". The defect is not the destination. It is that a non-deterministic
artifact is written over a committed path on every gate run.

## Why it matters

1. **It breaks the clean-tree contract every lane is held to.** "Confirm the working tree
   is clean before you start" is the standing rule. A lane that runs the sweep ends dirty
   through no fault of its own, so a genuinely dirty tree and a swept tree look the same.
2. **It invites a wrong commit.** A lane that runs `git add -A` after a sweep puts a
   regenerated screenshot into its feature commit. That is a silent, recurring
   contamination of unrelated commits.
3. **The current mitigation is a human step.** "Restore the churned PNGs" is carried in
   prose and done by hand per lane. A manual restore is the kind of instruction that is
   skipped once and never learned from.

## This is NOT todos/0341 or todos/0357

That pair is the **cross-tree** guard family: a runner launched from a foreign cwd writes
into *another* tree (`tests/lib/tree-guard.js`, `assertSameTree`). todos/0357 even cites
"the stray `logs/2026-07-25/*.png` that motivated 0341" — but the defect there is *which
tree* got written. **This item is about the correct tree**: `os-hires.mjs`, run the
sanctioned way in its own worktree, still dirties that worktree. Do not fold this item
into 0357, and do not close it by pointing at `tree-guard.js`.

## Plan

1. Write the screenshots to a gitignored **build/** output path (the convention the other
   suites already use, for example `build/test-browser/`). Make the test print the path it
   wrote.
2. Keep the artifact story. If a dev-log illustration is wanted, make it a deliberate copy
   step — a documented one-liner, or an opt-in `--save-log-artifacts` flag — not a side
   effect of every gate run.
3. Reconcile the stray name. Either commit a `hires-before-1x.png` deliberately, or stop
   emitting it. Two committed variants (`-2x`) and one uncommitted (`-1x`) is the drift
   that made this invisible.
4. Retire the manual "restore the churned PNGs" instruction wherever it is carried, in the
   same commit that removes the need for it. A mitigation left in prose after the defect is
   fixed becomes a false trap for the next reader.

## Acceptance

- `node tests/browser/os-sweep.mjs` (full, unfiltered) leaves `git status --porcelain`
  **empty** on a clean tree. State the command and paste the empty result.
- No tracked file under `logs/` is written by any file in `tests/browser/`. Prove it by
  derivation, not by sample: grep the suite for writes that resolve under `logs/` and
  print the count. Expect 0.
- `os-hires.mjs` still asserts the same display behaviour it does today. Its checks are not
  weakened to dodge the artifact. Give its check count before and after.
- If a dev-log copy path is kept, it is opt-in and documented in the file header.

## Notes

Scope is the sweep's tree hygiene only. Do not change the hires/zoom behaviour under test,
and do not touch `tests/lib/tree-guard.js` — todos/0357 owns that seam.
