# Handoff — start of thread (updated 2026-07-12; 0132 single-column + gucOS-band/bottom-All-Programs follow-up landed)

## Latest: 0132 Start-menu follow-up (gucOS band + bottom All Programs)

On top of the single-column revert below, a user-requested visual pass landed
(same commit stream): a **gucOS branding band** down the left of the Start menu
(root now **192×274**; vertical navy→blue gradient + "gucOS" via the new
`draw_text_vert_s`, the 5×7 font rotated 90° CCW reading bottom-to-top) and
**All Programs moved to the BOTTOM** of the column (XP/Vista/7 layout; cascades
upward via the work-area clamp). Tests re-geometried to 192×274 (`AP_ROW`, band
pixel assert, Run… at column row 1, keyboard Up→bottom All-Programs); kernel
wm_service + all os-shell Start-menu legs green. Image **v77**. Dev log:
`logs/2026-07-12/0132-startmenu-branding-and-bottom-allprograms.md`.
**Icons**: filed **todos/0157** (P1) — a real permissively-licensed icon set
(recommend Pixelarticons/MIT); there's no icon-image path in wm.c today, so it's
a pipeline, not an asset swap. **Gotcha**: `git worktree remove` leaves its
detached `serve.js` running — a zombie on port 3197 made os-shell boot the stale
worktree; `lsof -iTCP:<port>` + kill if a browser test won't boot.

> For the next Claude session: read this, orient, then **ask the user what
> to work on** — don't start anything without direction. Delete or rewrite
> this file when the thread's work lands (it's a baton, not documentation;
> the durable state lives in `todos/README.md` + `todos/done/` + `logs/`).

## Where the repo stands

**0132 (Start menu: All Programs flyout skips over the right pane) is DONE
and committed.** Shipped **option C** from the item: dropped the 0098 Win7
two-pane root back to ONE Win95 column and folded the fixed places into it.

- **os/wm.c** — the root is now a fixed **170×274 single column**: pins +
  MRU recents + All Programs, then a groove and **Settings**/**Run…**
  (folded in from the retired right pane), with the search box at the foot.
  `SM_ROOT_W = SM_COL_W` (170), so the unchanged 0078 cascade formula
  (`mcol[0].x + SM_ROOT_W - 3`) hangs the All-Programs flyout **snugly** off
  the column's right edge instead of past a second pane — the whole fix.
  New enum kinds SMI_SETTINGS/SMI_RUN; dropped SM_RIGHT_W / `sm_rhover` /
  `sm_right_activate` / the 176-grey right-pane band.
- **Option A declined** (Win7 in-place slide): layout-correct only with a
  *scrollable* pane — the fixed row budget truncates the baked tree — i.e.
  the "too heavy" case the user flagged as the trigger for C. Rationale in
  the todo + `logs/2026-07-12/0132-startmenu-single-column.md`.
- Docs: WM.md "Start menu v3" rewritten single-column; CLAUDE.md os/ para
  updated (+ the stale "v64" bumped to **v76**); `image.json` version 76.

Dev log: `logs/2026-07-12/0132-startmenu-single-column.md`. Item:
`todos/done/0132-start-menu-allprograms-flyout.md`.

## Tests / verification

- **`node tests/kernel/run.js --filter=wm_service` — GREEN.** Re-geometried
  to the 170×274 column: menu-shot pixel checks, Run… click at column row 2,
  and the Run… leg now clears recents+pinned first (Run…'s row shifts with
  the MRU count now that it's in the column, not a fixed right-pane row).
- **Full `node tests/kernel/run.js` — 58 passed, 0 failed** (wm.c is core;
  no wm-adjacent regression).
- **`node tests/browser/os-sweep.mjs --filter=os-shell`** — all 0132
  Start-menu legs pass (single-column open, snug All-Programs cascade,
  recents relaunch, live search + Enter, Run… dialog). Added a
  `clearRecents()` helper reused before the two Run… legs.

## ⚠ Carried-off pre-existing failure → todos/0156 (P0, NEW)

`os-shell.mjs` fails deterministically at the **unrelated** todos/0103
desktop-icon rename leg: `pixel (49,52) never became 0,0,128` — a window
occludes the top-left desktop icon so its selection highlight never shows.
**Verified pre-existing**: fails byte-identically on unmodified HEAD (stash
0132 → rebake v75 → same failure). Filed as **0156** (P0) with an (a) wm.c
placement vs (b) brittle-test triage. This is the only failing os-shell
check; it is NOT a 0132 regression.

## Gotchas carried forward (trimmed to the live ones)

- **Playwright IS installed on this box.** Launch Chromium with
  `--enable-unsafe-webgpu --enable-features=Vulkan` (the os-sweep harness
  does this). Worktrees can't resolve pnpm's symlinked `playwright` for a
  bare ESM import — to test HEAD in isolation, `git stash` in the main repo
  instead of a `git worktree` (that's how 0156 was attributed).
- **`os/os-system.img` re-bakes when a seeded source is newer** than the
  blob (0082 input-staleness) — expect a one-time ~90s bake after a wm.c/
  image.json edit. Image version is **v76**. Bump `image.json` `version` on
  any seeded `os/*.c/.h/.rc` or `compiler.js`/`host.js`/`vendor/` edit.
- **`queue.js done` stages a PRE-EDIT blob** of the done file — after
  `done`, `git add todos/done/<file>` again (done this session; verified the
  staged blob carries the DONE Status line).
- **Concurrent sessions may exist: stage ONLY your own files**; re-check HEAD
  before committing.
- Queue changes via `node todos/queue.js` ONLY; `check` must pass before
  committing. List order is PRIORITY-BUCKETED (P0–P3), so P0 bugs lead.

## Next in queue

`node todos/queue.js list` for the authoritative order. **0156** (the
os-shell rename-leg failure) is now the lead **P0**. After it, the P1 head is
**0079** (project dep dedup), then **0080** (cairo pdf/svg surfaces),
**0052/0053** (loopback AF_INET / curl-over-fetch), **0064** (WM browser
sweep). **0148** (test-tightness sweep) can lean on the 0147 flake gate.

## Operator-owed (browser, Playwright required — but it IS here)

- **0064** — the standing WM browser-sweep debt (pointer-lock human check).
- **0152** — a `--clang` browser boot confirming the served overlay renders.
- **0153** — run `os-sweep.mjs` to validate the 0146/0083 harness conversions
  (NB: it will surface the 0156 failure until that's fixed).

## Don't re-litigate

posix_spawn-not-fork; kernel-owned fds; WM.md invariants; DISK-IMAGE.md's
settled layout; 0013–0155's recorded decisions (see todos/done/). **0132's
call: single-column Start menu (option C), not the Win7 in-place slide
(option A) — A needs a scrollable pane the fixed row budget can't give, and
the user pre-blessed C as the escape hatch for exactly that.**

## Suggested opening for the new thread

"Read HANDOFF.md, then give me a one-paragraph status and ask what I want to
tackle — `node todos/queue.js list` for the order (0132 Start-menu
single-column just landed; the lead P0 is now 0156, a pre-existing os-shell
desktop-icon rename-leg failure carved off during 0132)."
