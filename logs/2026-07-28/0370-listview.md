# 0370 — SysListView32 + SysHeader32 + the AQM agent seam

Lane branch `0370-listview` off `a51e7e6a`. Ticket `todos/0370`; design
`todos/SOFTWARE-NATIVE.md` §3 (Path 1 — build the real reusable controls —
ruled by jku 2026-07-28, not re-litigated here).

## Step zero: the drivability question, answered with a live probe

The ticket demanded confirmation, not assumption: are LISTBOX/COMBOBOX
contents `wmctl`-visible today? Live probe (headless boot, ctldemo's
listbox fed three rows):

- `wmctl gettext LISTBOX:0` → the rows, newline-joined with the `"> "`
  selection mark. **Visible** — LISTBOX's WM_GETTEXT row-per-line
  convention already existed, and `wait text LISTBOX:0` rides it.
- `wmctl tree` → rows only inside the win line's `text='…'` field, which
  tree_dump truncates at 160 bytes. A real catalog is cut off. **Partial.**
- `wmctl click punes` → exit 1, `wmctl: no widget with that label`.
  **Gap confirmed**: a row was NOT a click/label target. This is exactly
  why `test_fileman_e2e.js` drives row selection as `click focus; HOME;
  DOWN×N` — keyboard ordinals standing in for the missing name path.
- COMBOBOX: **not a control** — never registered; it exists only in the
  dialog-template class table where an unregistered class takes the 0211
  fail-loud skip. Nothing to retrofit (its future registration inherits
  the seam by construction).

## The seam (the part that outlives this ticket)

`win32_internal.h` grows two veneer-internal messages, cut at the
user32↔any-control boundary so user32 stays ignorant of control internals:

- `AQM_DUMPCHILDREN` — tree_dump sends it to EVERY window after that
  window's own `win` line; a control that answers returns a malloc'd block
  of pre-indented lines spliced into the dump (the menu_dump/0171 shape;
  MSAA's listview-rows-as-accessibility-children idea). Non-item controls
  need zero code: DefWindowProc returns 0 = "no answer".
- `AQM_FINDLABEL` — `agent_serve` offers the label to each shown control
  AFTER window text and menu items both miss (rows are the lowest-
  precedence namespace, so no existing label resolution changes). The
  contract's load-bearing bit: `act=0` must be side-effect-free, because
  `wmctl wait label/text` POLLS it; `act=1` performs the item's click
  semantics (select + focus + ensure-visible + notify). One walker
  (`agent_find_row`) serves AQ_CLICK (act=1, enabled-gated) and AQ_GETTEXT
  (act=0).

Answering classes: SysListView32 (`lvrow i=N [sel] text='a | b | c'`,
col-0 match), SysHeader32 (`hdcol i=N text='Name'`, title match → a
header click, so `wmctl click Version` sorts BY NAME), LISTBOX
(`lbrow …`, item match — the confirmed gap closed in the same commit).
`wmctl` needed zero changes; `0372`'s treeview slots in without touching
user32 again.

## The control

`os/win32/listview.c` (new TU in lib.json, the menucore one-facility-per-TU
precedent), public-API-only like the comctl32 status bar. Report view:
header child owns columns (drag-resize dividers with live reflow,
HDN_ITEMCLICK), items carry per-column texts + state + lParam, selection
lifts LISTBOX 0106's single/extended semantics, LVM_SORTITEMS travels
state/focus with rows (temp marker bit through qsort), embedded SCROLLBAR
child (NOT repeating the LISTBOX WS_VSCROLL no-bar divergence),
WM_NOTIFY, A/W message entries translating at the control. Fail-loud:
non-report view styles, LVIF_IMAGE, extended styles beyond
LVS_EX_FULLROWSELECT, and — a policy catch-all — ANY unimplemented
LVM_*/HDM_* message reports through WIN32_UNSUPPORTED instead of
DefWindowProc's silent 0 (the 0211 demand log).

## Gotchas that cost time

- **WM_SETFONT must still reach DefWindowProc**: the per-HWND font store
  (0223) lives THERE; an intercepting control that returns without
  delegating silently keeps the stock font for itself while its children
  honor the new one.
- **The stock font cell is 28px in win32 apps** — not the 19/20px the wm
  estate uses. Two lvtest legs failed until measured (`ctldemo lvmetrics`
  print kept, the tabmap precedent): visible rows in a 140px control are
  3, not 5, so a keyboard leg had already scrolled the view before the
  scroll block sampled its baseline. Pin scroll state (ENSUREVISIBLE 0)
  before sampling, and pin it again before pixel-coordinate mouse legs.
- **drive.js `section()` ends at the next `==`** — a `wmctl tree` dump
  starts with `== pid N`, which truncates the section to nothing. The
  user32 e2e carries a local `==cut`-bounded section() for exactly this;
  copied, not re-derived (the hard way).

## Deferred

- `todos/0384` — horizontal scroll (columns wider than the client clip
  today; sanctioned-out-of-scope list didn't name it, so it's surfaced as
  its own ticket rather than silently cut).
- `todos/0130` annotated at the plan level: its "a LISTBOX of" association
  list should build on the real listview now.

Tests: `ctldemo lvtest` (57 checks), `tests/kernel/test_listview_e2e.js`
(34 checks: message surface green in-OS, rows/columns by NAME through
tree/click/gettext/wait, sort via header click, keyboard, pixel
dblclick/rclick, LISTBOX retrofit). Image bump owed (ctldemo baked) —
master assigns the version at merge.
