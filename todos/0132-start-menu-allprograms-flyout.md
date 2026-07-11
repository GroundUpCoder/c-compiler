# 0132 — Start menu: All Programs flyout skips over the right pane

- **Status**: open
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

## Plan (pick one)

- **A — Win7 in-place slide (layout-correct, more work).** "All Programs"
  replaces the LEFT pane contents with the group/leaf tree in place (indented
  rows, a Back row at the foot returns to pins+recents). No flyout window; the
  right pane stays. Reuses the existing tree walk (`sm_open_allprogs` reads
  `mcol[0].dir`); the flyout columns (`menu_open_flyout`, startmenu2/3) are
  retired for the All-Programs path (keep them for `/etc/menu` subdir cascades
  if still wanted, or fold those into the same in-place tree).
- **B — anchor the flyout to the left pane's right edge (cheap).** Open the
  cascade at `mcol[0].x + SM_LEFT_W - 3` instead of `+ SM_ROOT_W - 3`, so it
  hangs off the All-Programs row. Simpler, but the flyout then overlaps the
  Settings/Run right pane (acceptable Win95-ish, but not Win7-faithful).

Recommend **A** to match the two-pane chrome; **B** is the fallback if the
in-place tree is judged too heavy for the payoff.

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
