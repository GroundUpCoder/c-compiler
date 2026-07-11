# 0106 — fileman navigator v2: details view, multi-select, refresh

- **Status**: DONE (2026-07-11). Landed details columns (size/<DIR> + mtime
  off the same `refill` stat, a right-aligned mono layout) + a status strip;
  LBS_EXTENDEDSEL in user32.c (Ctrl-click / Shift-range / Ctrl+A / the
  LB_GETSEL/SETSEL/GETSELCOUNT/GETSELITEMS surface) with fileman's cut/copy/
  delete acting on the whole SET; Enter opens the caret (dir navigates /
  file associates), Backspace = Up, F5 refresh, Alt+Left back history; the
  View toggles (Sort by Name/Size/Date, Reverse, Show Hidden Files) as
  pane-context-menu items. Tests: `tests/kernel/test_fileman_nav_e2e.js`
  (new, registered in run.js) + the os-fileman.mjs multi-select+Delete
  browser leg (operator-run — no Playwright in-repo). Design note: the View
  controls are context-menu items, NOT a window menu bar — a bar (MENU_BAR_H)
  shifts the surface client origin and would break the 0092/0093 tests'
  hardcoded right-click geometry; context-menu items are equally
  agent-drivable and v1-honest (matching the "no generic listview" non-goal).
  Residue: the *optional* unprompted auto-refresh (mtime poll) is filed as
  **0123** (P3).
- **Design**: `todos/WIN32.md`. Filed by the 0076 parity sweep. Sequenced
  after 0092 (file ops): ops define what a selection *does*; this item
  makes the navigator side of fileman feel like Explorer. The 0073 sweep
  seeds one of these (Enter-doesn't-Open).

## Goal

fileman's list pane is a bare single-select LISTBOX: no size/date
columns (`refill` stats each entry and throws the result away), Enter
doesn't open, F5/refresh doesn't exist (a file created outside fileman
never appears until you re-navigate), no status bar, no multi-select, a
fixed dirs-first-alpha sort, and dotfiles are always shown (0076
survey). 0092 gives fileman verbs; this gives it a real navigator.

## Plan

- **Details view** — render size (files) and mtime columns from the
  stat `refill` already performs; right-align size, fixed-width date.
  Keep the single LISTBOX with column-formatted strings (LB_SETTABSTOPS-
  style padding) rather than a new listview control — v1 honest.
- **Multi-select** — LBS_EXTENDEDSEL-equivalent in the LISTBOX control
  (user32.c grows Ctrl/Shift-click + LB_GETSELITEMS); fileman ops (0092)
  act on the set. This is the user32 half 0077 does for the desktop.
- **Enter opens** the selection (the 0073 seeded gap); Backspace = Up.
- **F5 / refresh** — re-run `refill` on F5 and after every 0092 op;
  optionally piggyback the existing 500ms reap timer with an mtime check
  on the cwd (cheap stat) so external creates appear unprompted.
- **Status bar** — "<N> item(s)  <selected summary>" strip at the bottom
  (0073 notes the status-bar class draws no size grip — fine).
- **Sort + hidden toggle** — View menu: sort by name/size/date +
  reverse; Show hidden files toggle. NB the hidden-by-default half
  already landed with 0093 (refill skips dotfiles so the .recycle store
  doesn't clutter /root) — this item adds the way to turn them back ON.
- **Back history** — a small pushdown of visited paths; Backspace stays
  Up (Win95), Alt+Left = Back.

## Non-goals (record, don't build)

- Icons/thumbnails view, tree pane, address autocomplete, search (0092's
  non-goals stand).
- A generic header/listview control — column strings suffice until a
  second consumer exists.

## Acceptance

- Headless (`test_user32_e2e.js` / fileman leg): details rows carry
  size+date matching stat; Ctrl-click builds a multi-selection readable
  via the agent tree; Enter on a dir navigates, on a file opens; F5
  after an external `touch` shows the file; hidden toggle flips dotfile
  visibility; sort-by-size reorders.
- Browser (`os-shell.mjs`): visual check of columns + status bar; a
  multi-select then 0092 Delete removes the set.
