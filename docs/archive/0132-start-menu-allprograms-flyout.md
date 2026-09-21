# 0132 — Start menu: All Programs flyout skips over the right pane

- **Status**: DONE (2026-07-12) — shipped **option C**: dropped the 0098 Win7
  two-pane root back to ONE Win95 column (170×274), folding Settings/Run… into
  the column below a groove. The 0078 cascade formula (`mcol[0].x + SM_ROOT_W
  - 3`) is now correct for free — the All-Programs flyout hangs snugly off the
  column's right edge instead of past a second pane. Pins/recents/live-search
  kept. Option A (Win7 in-place slide) declined: layout-correct only with a
  scrollable pane (the fixed row budget truncates the tree), i.e. the "too
  heavy" case the user flagged as the trigger for C. os/wm.c + WM.md + CLAUDE.md
  + image.json v76; re-geometried `test_wm_service_e2e.js` (green) +
  `os-shell.mjs` (Start-menu legs green). A pre-existing, unrelated os-shell.mjs
  failure (the todos/0103 desktop-icon rename leg, `(49,52)` never navy — fails
  byte-identically on HEAD) was carved off to **todos/0156** (P0) so this could
  close clean. Dev log: `logs/2026-07-12/0132-startmenu-single-column.md`.
- **Design**: `todos/WM.md` "Start menu v3 — Win7 two-pane (todos/0098)";
  `os/wm.c` `sm_open_allprogs()` / `menu_open_flyout()`.

## Goal

Fix the visually-detached "All Programs" cascade in the Win7 two-pane Start
menu. Today the `ALL PROGRAMS` row lives in the LEFT pane (x ≈ 10–160), but
its submenu (Accessories/Demos/Games) opens at `mcol[0].x + SM_ROOT_W - 3`
— to the right of the WHOLE 290px panel, past the Settings/Run right pane.
The right column sits in the gap, so the flyout reads as belonging to
nothing. (Screenshot + write-up in the 2026-07-12 investigation.)

Root cause: the two-pane root (0098) kept the Win95/XP cascade *mechanism*
from 0078 unchanged. When the root was a single column, "flyout at the
root's right edge" sat snugly beside the item; now that the root is two
panes wide, the same formula throws the flyout past the right pane.

## Background — what real Windows did

- **Win95/98/2000/XP**: single-column menu. "Programs"/"All Programs" was a
  plain item with a ▸ arrow whose submenu cascaded *immediately to its
  right*, adjacent — no gap, because there was no second pane. Our cascade
  is faithful to this; it just doesn't fit a two-pane root.
- **Vista/7**: the two-pane menu we now mimic. "All Programs" did NOT
  cascade — clicking it **slid the programs tree in place over the left
  pane** (pinned/recent list replaced by an indented scrollable tree + a
  "◄ Back" button), the right pane unchanged. This is the layout-correct
  behavior for the chrome we've committed to.

## User decision (2026-07-12)

The user wants the jump-over fixed. **If the layout-correct fix is too heavy,
their explicit preference is to DROP the right pane entirely and go full
Win95 single-column** (option C) rather than accept the overlap of option B.
So the order of preference is **A (or C) > C > B**: a clean layout wins, and
if the two-pane chrome is the thing making it awkward, throw the second pane
away rather than half-fix it. Do NOT ship B (overlap) as the final state
without checking back.

## Plan (pick one)

- **A — Win7 in-place slide (layout-correct, more work).** "All Programs"
  replaces the LEFT pane contents with the group/leaf tree in place (indented
  rows, a Back row at the foot returns to pins+recents). No flyout window; the
  right pane stays. Reuses the existing tree walk (`sm_open_allprogs` reads
  `mcol[0].dir`); the flyout columns (`menu_open_flyout`, startmenu2/3) are
  retired for the All-Programs path (keep them for `/etc/menu` subdir cascades
  if still wanted, or fold those into the same in-place tree).
- **C — full Win95 single-column (drop the right pane) — user's fallback.**
  Retire the two-pane 0098 root: no Settings/Run right pane, the root becomes
  one column (pins + recents + All Programs + search box). The cascade formula
  (`mcol[0].x + c->w - 3`) is then correct *for free* — a single-column root is
  exactly what 0078's flyout math assumes, so the flyout hangs snugly off the
  right edge with no gap. Folds the right-pane places (Settings→ctlpanel, Run…,
  Shut Down) back into the column as ordinary rows. Reverts the Win7 styling in
  favor of the classic look the user prefers; update WM.md "Start menu v3".
- **B — anchor the flyout to the left pane's right edge (cheap, NOT preferred).**
  Open the cascade at `mcol[0].x + SM_LEFT_W - 3` instead of `+ SM_ROOT_W - 3`,
  so it hangs off the All-Programs row. One constant, but the flyout then
  overlaps the Settings/Run right pane — the user has said they'd rather have C
  than this overlap. Fallback of last resort only.

Recommend **A** to keep the two-pane chrome, else **C** (the user's stated
preference over a half-fix). **B** only if both are judged not worth it, and
even then confirm with the user first.

## Acceptance

- The All-Programs group/leaf list is visually contiguous with the "All
  Programs" affordance — no empty right-pane gap between the row and its
  submenu (browser pixel/geometry assert in `tests/browser/os-shell.mjs`,
  which already drives this cascade).
- Existing `os-shell.mjs` "All Programs cascades / Demos group cascades /
  nested click launches winbox" legs updated to the new geometry and pass.
- Keyboard nav (arrow-Right into the tree, Left/Esc back out, type-ahead)
  still works; `/etc/menu` subdir groups still reachable.
- `node todos/queue.js check` passes; no regression in the desktop-shell
  kernel e2e.

## Notes

- Found during a manual look at the live menu (the todos/0127 sweep class),
  but filed as a dedicated item because it's a specific design fix, not a
  general dogfood pass.
- If A is chosen, update the WM.md "Start menu v3" paragraph (it currently
  documents the cascade flyouts as the All-Programs mechanism) and bump
  `os/image.json` `version` (wm.c is a seeded source).
- If C is chosen, the WM.md "Start menu v3 — Win7 two-pane" paragraph is
  rewritten wholesale (back to a single column) and the `os-shell.mjs`
  right-pane legs (Settings/Run) are removed, not just re-geometried. Same
  `os/image.json` version bump.
- Filed P0 per the shipped-feature-bug policy (a visible layout defect in the
  landed 0098 Start menu); leads the queue.
