# 0106 — fileman navigator v2 (details, multi-select, refresh)

Turned fileman's bare single-select LISTBOX into a real Explorer-shaped
navigator. The work split cleanly across the user32 veneer (a generic
extended-select LISTBOX) and fileman itself (the details data model + the
navigator chords).

## user32.c — LBS_EXTENDEDSEL

The LISTBOX grew a selection SET alongside the existing caret. `LbState`
gained `unsigned char *marks` (one flag per item, realloc'd in lockstep
with `items`), an `anchor` (shift-range pivot) and a `multi` flag read from
the style at WM_CREATE (`LBS_EXTENDEDSEL | LBS_MULTIPLESEL`).

- **Click**: plain replaces the set; Ctrl toggles one and moves the anchor;
  Shift ranges from the anchor (clearing unless Ctrl+Shift adds). Modifiers
  come from `GetKeyState(VK_CONTROL/VK_SHIFT)` (the `g_mod` word) — the same
  source the recycle test already drives with `wmctl keydown`.
- **Keyboard**: arrows move the caret and, in multi mode, replace the set
  with the caret; Shift+arrow extends from the anchor; Ctrl+A selects all.
- **New messages**: `LB_GETSEL`/`LB_SETSEL` (index or -1=all),
  `LB_SELITEMRANGE`, `LB_GETSELCOUNT`, `LB_GETSELITEMS`. All multi-only —
  single-select listboxes return `LB_ERR`, so notepad's comdlg file dialog,
  ctlpanel, winmine etc. are byte-unchanged (verified: their e2es pass).
- **The caret/set split is load-bearing**: `LB_SETCURSEL` in multi mode
  moves ONLY the caret (no marks touched), so fileman's right-click can
  position the caret on the hit row without collapsing a multi-selection.
  WM_GETTEXT (the agent-tree readback) marks every selected row with `> `.

## fileman.c — the navigator

- **Details model**: `refill` now keeps a file-scope `g_ents[]`
  (name/isdir/size/mtime) index-aligned with the rows, and every row op
  resolves its target through `g_ents[row]` (`row_path`) instead of
  re-parsing the display string — the columns would otherwise confuse a
  re-parse. Rows render `"%-28s %10s  %s"` (name+`/`, right-aligned bytes or
  `<DIR>`, `YYYY-MM-DD HH:MM`) — the mono font makes space-padding an honest
  column, no LB_SETTABSTOPS needed.
- **Status strip**: a bottom STATIC showing `N object(s)` and, with a
  selection, `K selected (B bytes)`; updated on refill + LBN_SELCHANGE.
- **Ops on the SET**: cut/copy push every selected path onto the one kernel
  clipboard slot; delete confirms singular (the 0092/0093 wording, kept
  byte-identical) for one item and `these N items` / "Confirm Multiple Item
  Delete" for many, then trashes/deletes each.
- **Chords** (message loop): F5 refresh (any focus), Enter opens the caret
  (dir → navigate, file → associate), Backspace = Up (Win95), Alt+Left =
  back, Enter in the path bar = Go. Back history is a 32-deep pushdown that
  `navigate`/`go_up` push and `go_back` pops.
- **View toggles**: Sort by Name/Size/Date + Reverse + Show Hidden Files, as
  MF_CHECKED items on the pane context menu.

### Why context-menu View items and not a menu bar

The plan said "View menu". A real user32 menu bar (`MENU_BAR_H = 20`) shifts
the top-level client origin down, and the 0092/0093 fileman tests right-click
at hardcoded surface coords (`100 30` = row 0, `100 300` = pane). A bar would
move every row 20px and break them wholesale. Context-menu items are equally
agent-drivable (`wmctl click "Sort by Size"`), keep the geometry stable, and
match the item's own "no generic listview control until a second consumer"
v1-honest posture. Full intent (all three sort keys + reverse + hidden
toggle) is met.

## Tests

- New `tests/kernel/test_fileman_nav_e2e.js` (registered in run.js): 17
  checks — details columns match stat, Ctrl-click + Shift-range build a
  multi-selection readable via the agent tree, multi-delete removes the set,
  Enter/Backspace navigate, F5 shows an externally-`touch`ed file, Sort by
  Size reorders, Show Hidden reveals a dotfile, Alt+Left walks back. Row
  height measured at 18px (surface y=30→row0, 50→row1, 78→row2).
- Updated `test_fileman_e2e.js`: the old contiguous `Desktop/\nid1/\n…`
  listing regex assumed name-only rows; relaxed to tolerate the details
  columns (`[^']` spans the padding/date/`\n`) + a status-strip count assert.
  The tree dump caps item text, so the three leading dirs are the anchor.
- `test_fileman_ops_e2e`, `test_recycle_e2e`, `test_user32_e2e`,
  `test_openwith_e2e`, `test_ctlpanel_e2e`, `test_winmine_e2e`,
  `test_notepad_e2e` (comdlg listbox) all still PASS.
- `os-fileman.mjs` grew a Ctrl-click multi-select + Del leg (code only —
  Playwright isn't installed in-repo, so this is operator-run, like the rest
  of the browser sweep).

Image `version` → 66 (fileman.c/user32.c/windows.h are bake inputs).

## Residue

The *optional* unprompted auto-refresh (poll the cwd mtime off the 500ms
reap timer) was not built — F5 + refresh-after-op cover the need. Filed as
**0123** (P3), which also notes carrying the selection across an auto-refill.
