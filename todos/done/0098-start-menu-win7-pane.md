# 0098 — start menu: Win7 two-pane stage

- **Status**: DONE (2026-07-11). wm.c's root ("startmenu") is now a fixed
  290×234 two-pane panel: left pane = pinned (`~/.config/pinned`) + MRU
  recents (`~/.config/recent`, pushed by the shared `activate()` on every
  real launch, dedup, cap 8) + an All Programs row, with a live search box
  at its foot that filters a flat walk of the menu tree (Enter launches the
  top hit); right pane = the fixed places (SETTINGS, RUN…). All Programs
  cascades the tree via the unchanged 0078 flyout machinery (startmenu2 =
  groups, startmenu3 = leaves). The Win95 sidebar band + below-programs
  separator/fixed-section are gone. Tests: rewrote the Start-menu legs in
  `tests/kernel/test_wm_service_e2e.js` (recent-grows, two-pane shot
  pixels, search+Enter, Esc clear-then-close, right-pane RUN…, keyboard
  All Programs cascade) and `tests/browser/os-shell.mjs` (two-pane render,
  cascade launch, recents relaunch, live search, RUN…) — both PASS; kernel
  suite 53/0. Image v59→v60. Dev log
  `logs/2026-07-11/0098-start-menu-win7-two-pane.md`. Non-goals (jump
  lists/tiles/fs-search/menu glass) recorded, not built; no follow-ups.
- **Design**: `todos/WM.md` "The desktop shell" (Start menu v2 block,
  todos/done/0078 — the Win95-classic structure this builds on).

## Goal

The optional second stage 0078 descoped: restyle the Start menu from the
Win95 cascading-column shell into the Win7 two-pane layout. 0078 landed
the substrate (menu tree loader, per-column windows, keyboard nav,
type-ahead, the Run… builtin, the Ctrl+Esc chord + WMP MENU/EV_MENU
path); this item is purely a new layout + two small persistence bits.

## Plan

- **Left pane** = pinned list + MRU recents: a small persisted recents
  file (e.g. `~/.config/recent`), appended by the wm's `activate()` on
  every launch; pinned entries a user file above it. (This also covers
  the "Documents" entry from 0078's Win95 fixed-section sketch — it was
  deliberately not built there because no recents store existed.)
- **Right pane** = the fixed places column (the 0078 fixed section moves
  here: Settings, Run…, and Shut Down once todos/0051 lands).
- **Search box** at the bottom of the left pane that filters the menu
  TREE live (reuses the 0078 type-ahead matcher over a flattened walk;
  this is also the "Find" entry from 0078's fixed-section sketch).
- The cascading flyouts remain for "All Programs" (the 0078 columns are
  the submenu mechanism either way).

## Non-goals (record, don't build)

- Jump lists, tiles, live filesystem search (only the menu tree) — same
  exclusions 0078 recorded.
- Aero glass on the menu — the glass tier is browser-only rendering
  (todos/0063); nothing here may change headless composites.

## Acceptance

- Headless: recents file grows on launch and the left pane lists MRU
  entries; typing in the search box narrows to matching tree entries;
  Enter launches the top hit.
- Browser (`os-shell.mjs` leg): the two-pane menu renders, a search-hit
  launch works, dismiss semantics unchanged from 0078.
