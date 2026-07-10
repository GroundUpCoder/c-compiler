# 0098 — start menu: Win7 two-pane stage

- **Status**: open
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
