# 0370 — SysListView32 + SysHeader32 + the AQM agent seam in user32 (jku: fuller user32 toolkit, real controls)

- **Status**: done
- **Difficulty**: heavy (≈3–4 lane-days)
- **Design**: `todos/SOFTWARE-NATIVE.md` — **NOW IN `main`** (merged by master
  cont-123 as `cf939313`; `487f8b70` verified an ancestor of main). A full design
  pass (control inventory, agent-drivability plan, costed split). **Read it
  before scoping; do not re-derive it.** ⚠️ The old pointer to
  `origin/design-software-win32 @ 487f8b70` is **stale** — read the copy in
  `main`, which is the one that absorbs later corrections.
- **Provenance**: **jku, 2026-07-28, verbatim** — *"for the software manager I
  do want fuller user32 toolkit so we have real controls. I want that work
  queued."* This settles the Path 1 vs Path 2 fork in the design pass in favour
  of **Path 1 — build the real reusable controls**. **No lane may re-litigate
  it**, and no lane may propose owner-draw `LISTBOX` approximations as a way to
  ship the software manager sooner. That is precisely the shortcut the estate's
  core principle rejects.

## Goal

`os/win32/user32.c` (~230 KB) registers exactly `BUTTON`, `EDIT`, `STATIC`,
`LISTBOX`, `COMBOBOX`, `SCROLLBAR`; `os/win32/comctl32.c` (~8 KB) provides
essentially only `STATUSCLASSNAMEA`. **Absent:** `SysListView32`,
`SysHeader32`, `ToolbarWindow32`, `SysTreeView32`, `SysTabControl32`,
`msctls_progress32`, `msctls_trackbar32`, `msctls_updown32`, tooltips, any
ImageList.

Ship the **report-view `SysListView32` + `SysHeader32`** (columns, selection,
sort-by-column) and the generic agent seam that makes item-bearing controls
drivable. jku asked for a *fuller user32 toolkit*, **not** "the minimum
ListView the software manager needs" — the software manager (`0371`) is the
FIRST CONSUMER of this work, not its boundary.

## THE ARCHITECTURAL CRUX — solve this at the toolkit level or not at all

`todos/TOOLKIT.md` records WHY Win32 was chosen over microui/Elm: **every
widget is an HWND in a persistent, queryable tree**, so `wmctl click "OK"`
resolves by walking that tree, never by pixels. That is a hard platform pillar.

**Real common controls break that invariant.** A `SysListView32`'s items are
not child HWNDs; they are internal items reached through `LVM_GETITEMCOUNT` /
`LVM_GETITEMTEXT`. Same for `SysTreeView32` (`TVM_*`) and, *today already*,
`LISTBOX` (`LB_GETCOUNT` / `LB_GETTEXT`). `software.c` gets agent-drivability
for free only *because* it does not use a list control: it creates one
`PkgCard` HWND per package whose window TEXT mirrors
`"<name> <version> [<state>]"`.

So a naive "build ListView, put packages in it" would silently regress the
platform's single most load-bearing pillar. **Design the seam FIRST; do not
build controls and discover the drivability problem afterward.**

The design pass's answer (better than the "T1 blocks everything" split an
earlier sketch proposed — the seam belongs *inside* this ticket, cut at the
**user32 ↔ any-control** boundary so it is generic on arrival):

- **`WM_GETTEXT` = content, row-per-line** (extends the LISTBOX/status-bar
  convention): header line, then one line per row, subitems joined `" | "`,
  `"> "` selection prefix. Needs **no** `wmctl` change — `wait text` already
  takes `CLASS:n` labels through the shared resolver.
- **`AQM_DUMPCHILDREN`** — `tree_dump` sends it to every window; a control that
  answers returns pre-indented lines spliced under its `win` line. This is the
  **menu precedent** (`menu_dump`, the 0171 fix) generalized, and is what
  Windows itself does (MSAA exposes listview rows as accessibility children).
  Necessary because `tree_dump`'s text field is capped at 160 bytes, so a whole
  catalog cannot ride `WM_GETTEXT`.
- **`AQM_FINDLABEL`** — `agent_find_ex`, having missed on HWNDs and menus,
  offers the label to each shown control; the listview matches a row by
  column-0 text.

**Net: drivability gets BETTER, not merely preserved.** `wmctl tree` shows all
columns instead of just card text, and clicks address rows **by name**,
deleting the fragile ordinal arithmetic today's e2e must predict
(`test_software_e2e.js`'s `punesBtn = 2 + sortedIndex`, which the tier-2
Start-menu work already had to re-derive once when a header button shifted).

⚠️ **Confirm as step zero, do not assume:** are current `LISTBOX`/`COMBOBOX`
contents `wmctl`-visible today, or is this an existing latent gap? If it is a
gap, the AQM seam closes it for those classes in this ticket too — that is the
generality test.

## Plan

1. Read `todos/SOFTWARE-NATIVE.md` (**in `main`** — see the Design line) in full.
   Confirm the LISTBOX/COMBOBOX drivability question above.
2. `commctrl.h` + `SysHeader32` + `SysListView32` **report view**: columns,
   selection, sort-by-column.
3. The AQM agent seam in user32 at the user32↔control boundary
   (`WM_GETTEXT` row-per-line, `AQM_DUMPCHILDREN`, `AQM_FINDLABEL`), applied to
   the existing item-bearing classes as well as the new one.
4. A `ctldemo` pane exercising the control.
5. `tests/browser/test_listview_e2e.js`.
6. **Image bump** — `ctldemo` is baked. Master assigns the version; a lane
   never touches `os/image.json`.

~800–1000 lines of C. Every pattern has an in-tree sibling to lift from.

## Deliberately OUT of scope (escape hatch named, per the design)

No icon/list/tile modes, no `LVS_OWNERDATA`, no checkboxes, no column
drag-reorder, no ImageList, no treeview this pass (**the AQM seam slots one in
without touching user32 again** — that is the generality claim, and `0372` is
its proof), no gucman/engine changes.

The rest of the absent-control list stays queued behind this as its own tickets
when they earn it — `msctls_progress32` (immediate consumer: `software.c`'s
install progress, today a status-line STATIC fed by tailing gucman),
`ToolbarWindow32` (chrome for `software.c` + `fileman`), `SysTreeView32`
(`ctlpanel`'s category rail in `0131`, a `fileman` folder pane),
`SysTabControl32` (property sheets). **Do not fold them into this ticket; do
not silently drop them either.**

## Why now — the customers already exist (the argument that does not need the core principle's teeth)

Four consumers have each **already hand-rolled an approximation**:

1. **fileman (`0106`, shipped)** — details columns are `%-28s %10s %s`
   space-padding into a mono LISTBOX; its own comment admits the workaround.
   Works only because the font is mono; re-sorts by rebuilding every row
   string; the "header" is a menu.
2. **comdlg32's file dialog (`0048`)** — another LISTBOX that would be a report
   view anywhere else.
3. **`0130` Default Programs** (re-opened 2026-07-27 by jku's cmdalt ruling) —
   its written plan says *"a LISTBOX of"* key→command pairs: **two-column data
   about to become the fifth padded-string hack.** ⭐ **Annotate `0130` at
   pickup** so it builds on this control instead of its written plan.
4. **`0371`** (this redesign), and **`0131`** ctlpanel is a fifth.

`PORTS.md` shows zero listview demand **only because the port corpus was chosen
to fit the veneer** — regedit / taskmgr / anything Explorer-shaped is
listview-first. The control converts a whole class from impossible to tail work.

Honest counterpoint the design raises and answers: strict Win95 fidelity would
favour Path 2 (real Win95 Add/Remove was a tabbed LISTBOX dialog). Rejected —
the estate's "native" envelope already deliberately spans eras (Aero `0063`,
Win7 snap `0095`, XP Start cascades `0132`; `0131` explicitly targets XP/Win7),
and the columned report view is the native idiom of every Windows utility from
2000 on.

## Acceptance

- `SysListView32` + `SysHeader32` register and work in report view: columns,
  selection, sort-by-column.
- `ctldemo` pane + `tests/browser/test_listview_e2e.js` green.
- **The drivability bar, non-negotiable:** every row and every action in the
  demo is addressable by NAME through `wmctl` (`tree`, `wait text`, `click`)
  with **no `wmctl` change** beyond what the seam requires, and the seam is cut
  at user32↔control so a future control inherits it.
- If the LISTBOX/COMBOBOX drivability gap is real, it is closed here too.
- Kernel + sweep green; image bumped (master assigns).
- `todos/LIABILITIES.md` is machine-checked by the `todos` suite — if this
  change rewrites an anchored line the gate goes RED; re-anchor or retire it in
  the same commit.
