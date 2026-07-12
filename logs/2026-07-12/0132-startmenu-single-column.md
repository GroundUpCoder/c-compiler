# 0132 — Start menu: All Programs flyout skips over the right pane

**Landed 2026-07-12.** Fixed the visually-detached "All Programs" cascade in
the Start menu by taking **option C** from the item: drop the Win7 two-pane
root (todos/0098) and revert to ONE Win95 column.

## The bug

0078 gave the Start menu a Win95-classic cascade: a group row's flyout opens
at `mcol[0].x + c->w - 3` — snugly off the root's right edge. 0098 restyled
the root into a fixed 290×234 **two-pane** panel (170px left: pins/recents/
All-Programs + search; 120px right: Settings/Run…) but kept that cascade
formula unchanged. With a 290px-wide root, `+ SM_ROOT_W - 3` throws the
"All Programs" flyout past the *whole* panel — the right pane sits in the gap,
so the flyout reads as belonging to nothing.

## Why C, not A

The item recommended **A** (Win7 in-place slide: replace the left pane with the
group/leaf tree, a Back row at the foot) to keep the two-pane chrome, else
**C** (single column), with the user's explicit steer that a clean layout wins
and B — the cheap overlap half-fix — must not ship without checking back.

A is only layout-correct with a **scrollable** pane: the left pane is a fixed
10-row slot budget, and the baked tree (Games has 8 leaves) already brushes it;
any growth truncates silently — an ironic latent bug for a P0 layout-fix.
Adding scroll to wm.c's software rasterizer is the "too heavy" case the user
flagged as the trigger for C. C, by contrast, makes the defect vanish **by
construction**: a single-column root is exactly what the 0078 flyout math
assumes, so `+ SM_ROOT_W - 3` hangs the cascade snugly again, with zero new
mechanism. It also keeps the nice 0098 features (pins, MRU recents, live
search) — only the right pane goes.

## The change (os/wm.c, single-column root)

- Root is now a fixed **170×274** single column. `SM_ROOT_W = SM_COL_W`
  (170); dropped `SM_RIGHT_W`. `SM_LEFT_W`→`SM_COL_W`, `SM_LEFT_ROWS`→
  `SM_ROWS` (bumped 10→12 to fit the fixed places without squeezing recents).
- The fixed places **fold into the column** as trailing rows: after pins +
  recents + All Programs, a groove, then **Settings** (SMI_SETTINGS →
  `/bin/ctlpanel`) and **Run…** (SMI_RUN → the startrun dialog). New enum
  kinds; `sm_rebuild_left` appends them (browse mode only — search mode
  suppresses them, as before). `sm_load_list` reserves `SM_FIXED + 1` trailing
  slots.
- Retired the right pane throughout: `sm_root_hit` is now zone {item, search,
  dead}; `sm_right_activate` folded into `sm_left_activate` (Settings/Run
  handled by kind); dropped `sm_rhover`; `draw_root_menu` lost the 176-grey
  band + divider + right-pane row loop and grew a groove above the fixed
  section. The `menu_open_flyout` / `sm_open_allprogs` cascade is byte-unchanged
  — only `SM_ROOT_W`'s value moved, which is the whole fix.
- Docs: WM.md "Start menu v3" rewritten single-column; CLAUDE.md os/ paragraph
  updated; `image.json` version 75→76 (wm.c is seeded).

## Tests

- **`tests/kernel/test_wm_service_e2e.js`** — re-geometried to the 170×274
  single column: menu-shot pixel checks (cascade arrow at SM_W−12, fixed-places
  text in column rows 1–2, search ghost), Run… click moved to column row 2
  (x 60), and — the one real gotcha — the Run… leg now **clears recents+pinned
  first** so Run… sits at a known row (with the two-pane right pane it was a
  fixed row independent of recents; folded into the column its row shifts with
  the MRU count). Green.
- **`tests/browser/os-shell.mjs`** — same re-geometry; added a `clearRecents()`
  helper reused before both Run… legs for the same reason. All 0132 Start-menu
  legs pass (single-column open, snug All-Programs cascade, recents relaunch,
  live search + Enter, Run… dialog).

## Pre-existing failure carved off → todos/0156 (P0)

os-shell.mjs fails deterministically at the *unrelated* todos/0103 desktop-icon
rename leg: `pixel (49,52) never became 0,0,128` — a window occludes the
top-left desktop icon so its selection highlight never shows. **Verified
pre-existing**: fails byte-identically on unmodified HEAD (stash 0132 →
rebake v75 → same failure). Filed as **0156** (P0) rather than absorbed here,
so 0132's Start-menu work lands clean. See 0156 for the (a) wm.c placement vs
(b) brittle-test triage.
