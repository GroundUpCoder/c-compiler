# v128 deploy batch — realpath #76 + puNES D-pad folded onto v127 icons

**What shipped in this image:** three landed fixes reach prod in ONE cold boot
instead of three: the #82 per-filetype desktop icon glyphs (already sealed as
v127 on main @ 12b2476), the realpath(3)/`readlink -f` physical symlink
resolution (gucOS #76, todos/0263, branch `realpath-symlink` @ 043fccc), and
the puNES D-pad routing through the canonical input API (todos/0213, branch
`punes-dpad` @ d8701a1). Both branches were gate-green individually; the point
of batching was (a) one boot for users, (b) a FULL gate over the *combined*
tree, because realpath and the v127 line both touch host.js/kernel.js — a
clean textual merge can still be semantically off.

## Merge shas

- `fdb8359` — Merge realpath-symlink (clean, ort)
- `866f6bc` — Merge punes-dpad (clean, ort)
- compiler.js byte-untouched across 12b2476..866f6bc (no codegen in this
  batch; the SameBoy byte-identity mandate therefore not triggered).

## The foreign-merge incident (stop-and-surface, then eject)

Mid-integration, a third merge appeared on this clone's main: `3e9bb47`
"Merge origin/mgba-shared-bug" (= dc7054e, the mGBA ALU compare-pipeline
backport) — a stray one-time merge by the B codegen thread, which is now
isolated in its own worktree (`mgba-compilerjs-fix`). Integration HALTED
rather than gating three-branch content under a two-branch mandate; the
coordinator ruled EJECT: the mGBA ALU fix is held for a later mGBA-focused
v129 boot together with the related compiler.js codegen fix. Resolution:
`git reset --hard 866f6bc` (nothing was stacked on the stray tip; origin/main
was never polluted; dc7054e survives on `origin/mgba-shared-bug`). Lesson
recorded: "sole writer on main" must mean *no other thread merges to the main
tree*, even from a worktree — worktree branches are the isolation boundary.

## Bake

`tools/mkimage.js` does NOT auto-bump — it seals whatever `os/image.json`
says (first bake attempt re-sealed v127). Manual manifest bump 127→128, then
`node tools/mkimage.js --packages=all` (the test-fixture/fat path):
`os/os-system.img` **v128, 38.1 MiB, sealed** over icons + realpath + dpad
only.

## Full gate (combined 2-branch v128)

- **blockfs 15/15** (host.js changed — walk/readlink territory)
- **kernel 94/94** — including test_realpath_e2e, test_desk_icons_e2e (the
  #82 probes post-merge), test_software_e2e (storefront), test_gucman_e2e,
  test_gucman_quake_e2e
- **browser sweep 31/31** — including os-shell (carries the #82 desktop-icon
  legs; there is no separate os-icons file), os-wm, os-user32, os-gucman
- **host ok + projects 26/26** (vendor builds incl. punes)
- **unit printf leg 1/1** (`snprintf_highbyte_roundtrip`, the 0266 latin1 P0
  regression guard)
- **flake gate green** (kernel + browser tripwires 3× under load, 0%)
- **test_punes_e2e 12/12 direct** — the D-pad leg explicitly green

One first-pass red, root-caused as load, not semantics: the initial full
kernel run went 93/1 with `test_gucman_quake_e2e` timing out on
`wmctl wait win Quake`. Cause: on a cold run the gucman legs bake the minimal
no-packages blob mid-suite while the parallel runner pegs every core, and
quake's 15 s window wait lost the race. Isolated rerun: 21/21 PASS; 3× repeat
under ×10 load: stable 0%; full-suite rerun (caches warm): 94/94. Not a
cross-branch interaction — the wait-timeout fail-loud discipline worked as
designed.

## Follow-ups (not in this batch, deliberately)

- `test_punes_e2e.js` is not registered in `tests/kernel/run.js`'s explicit
  file list — the branch never added it (its 12/12 was a direct run). Needs a
  registry line (and possibly a dist/packages precondition note) as its own
  small item.
- `test_gucman_quake_e2e`'s 15 s window wait is tight under cold-bake
  contention; if it flakes again in full runs, consider serializing the
  minimal-blob bake ahead of the suite (image-fixture-style) rather than
  lengthening the timeout.
