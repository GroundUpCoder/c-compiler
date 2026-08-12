# #665 — cold-worktree sweep false-red: package-index rebuilds now merge the sibling defs

## The bug

Five browser members (os-git-cli, os-git-net, os-gucman, os-minimal, os-rust)
rebuild `dist/packages` mid-sweep, and all of them spawned
`node tools/mkpkg.js --no-baseline --quiet` with **no `--defs`**. In a COLD
worktree that writes an index missing the sibling-defined packages
(`font-noto-cjk-mono`, `font-unifont` — sibling-only since the #615
migration), and serve.js's #614 guard then refuses to start for every later
member: 38 of 59 members die in `waitForServer` at ~220ms, having asserted
nothing. Warm trees never showed it because the #580 upsert carries
already-present entries forward — a no-defs rebuild in a warm tree preserves
the fonts it didn't build.

Reproduced cold on this lane's fresh worktree before changing anything:

- `node tools/mkpkg.js --no-baseline --quiet` (cold, 3m15s) → **77 packages,
  both fonts ABSENT by name**.
- `node serve.js . 3998 --strict-port` → **exit 1**:
  `dist/packages/index.json is missing sibling package(s): font-noto-cjk-mono,
  font-unifont`.

## The fix (b8b369be)

One rebuild path, reusing the ONE existing discovery — no second mechanism:

- **`buildPackageRepo()` in tests/browser/lib/os-harness.mjs**: resolves the
  sibling via `os-common.js resolveSiblingRepo` (env override → linked-worktree
  main-clone sibling → naive sibling), passes `--defs=<root>`, then verifies
  the WRITTEN index covers the sibling names (the same check the serve guard
  applies). On a gap it fails that ONE test loudly, names the missing
  packages, and removes the bad index so the failure cannot cascade into
  members that had nothing to do with it. A NAMED build (os-rust's
  `wc-rust --rust`) gets the sibling names appended: a cold tree has no prior
  index to carry them from, so a filtered cold `os-rust` run used to write a
  guard-refusing index too.
- **os-sweep.mjs #665 pre-step**: a PRESENT index missing sibling packages
  (left by a pre-#665 run, or a sibling that gained a package since the last
  rebuild) would cascade-fail every member that sorts before the first
  rebuilder. The sweep now probes the same gap up front and repairs it once,
  visibly, with the same merged rebuild (upsert — carried entries survive).
  No index at all is a normal cold state and is left alone (the guard only
  refuses a present-but-incomplete index).
- The five members drop their inline mkpkg blocks for the helper.

## Controls run

- **Positive (mechanism)**: helper rebuild in the lane worktree → 79 packages,
  both fonts present by name; serve.js starts and logs
  `merged package index covers all 2 sibling package(s)`.
- **Red (preflight)**: hand-deleted `font-unifont` from the index →
  `os-sweep --filter=harness-unit` printed
  `[os-sweep] dist/packages/index.json is missing sibling package(s):
  font-unifont — repairing with a merged rebuild (#665)`, repaired to 79
  with both fonts, member green.
- **Negative (sibling genuinely absent)**: fresh clone of the lane tip in
  /tmp with no `gucos-packages` anywhere near it (`resolveSiblingRepo` →
  null, probed). Cold there: helper builds the 77-package base index with no
  `--defs` and no coverage demand; `os-git-cli` (28 ok legs), `os-minimal`
  (43 legs, the `--minimal` serve shape), `os-rust` (8 legs, the named-build
  path) all green. Discovery returning nothing keeps the guard down — the
  fix does not require the sibling to exist.

## Gotchas recorded

- `build/` is NOT all-gitignored: `build/nondeterminism-0269/` is tracked.
  "Restore a worktree to cold" is `rm -rf dist build os/os-system*.img` **plus
  `git checkout -- build/`** — the first rm deletes six tracked files.
- serve.js pays the fat bake BEFORE the #614 guard, so a cold
  `serve.js` repro needs the bake to finish (or a prebaked image) before the
  refusal appears.
