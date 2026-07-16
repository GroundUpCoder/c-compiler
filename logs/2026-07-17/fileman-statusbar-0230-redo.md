# 0230 REDO — fileman's strip becomes the shared STATUSBAR (killing the shortcut)

The [same-day 0230 fix](fileman-status-descenders-0230.md) was a SHORTCUT
and got redone. What it landed — a private `status_h()` in fileman deriving
the strip height from `GetTextMetrics` — was a second, WEAKER copy of
height-derivation (`tmHeight + 2`, dropping the internal-leading and border
terms) sitting right beside the real one: comctl32's STATUSBAR already owns
the Win95/Wine `STATUSBAR_ComputeHeight` formula (`sb_height`), vcentered
descender-safe paint (DT_SINGLELINE|DT_VCENTER), self-parking on WM_SIZE,
and sunken part wells — and notepad already uses it. "Fileman-local, zero
blast radius" was the exact duplication-with-drift anti-pattern this
codebase is supposed to be killing; the honest lever list in the todo missed
the third and correct option entirely: **stop rolling a strip and use the
control**.

## What changed

- **fileman.c**: the raw `"STATIC"` g_status is now
  `CreateStatusWindow(WS_CHILD|WS_VISIBLE|CCS_BOTTOM, NULL, h, ID_STATUS)` —
  exactly notepad's idiom. `STATUS_H`, `status_h()`, and the manual
  `MoveWindow(g_status, …)` parking are DELETED; `relayout()` forwards
  WM_SIZE to the bar (it parks itself) and reads back the height it chose
  for the list-area bottom (notepad's main.c WM_SIZE pattern). The readout
  goes through `SB_SETTEXT`. Zero private strip geometry left in fileman.
- **comctl32.c / commctrl.h**: grew the ANSI entry `CreateStatusWindowA`
  (fileman is deliberately ANSI — POSIX paths are bytes); `CreateStatusWindowW`
  is now a thin wide wrapper over the shared `sb_create`. The header maps
  `CreateStatusWindow` per UNICODE, matching real commctrl.h.
- **Tests**: the 0230 descender leg in `test_fileman_ops_e2e.js` retargets
  to the bar (class `msctls_statusbar32`, glyph columns shifted by the
  bar's 6px well inset) — still ink/clearance-based, no magic heights.
  `test_fileman_e2e.js` / `test_fileman_nav_e2e.js` tree greps follow the
  class change. Bar height at the stock font is 25px (19 + max(lead,2) +
  2·CYBORDER + vborder), comfortably clearing the old ≥21 pin.

## Why the general control, spelled out

The strip now gets, for free and from ONE implementation: the correct
font-height formula (0229's fix — one place to be right), vcentered text
(descender clearance by construction, not arithmetic), auto-park at the
client bottom, part wells when fileman ever wants an Explorer-style
multi-part readout, and future WM_SETFONT handling. Any future fix lands
once in comctl32 and both consumers inherit it.

The ROOT disease — user32's STATIC paint top-aligns single-line text, so
every sub-cell-height STATIC label in the corpus latently clips — is a
different concern at a different layer and is filed as its own item,
**todos/0236** (DT_VCENTER in static_proc, guarded for multiline).

Image v107. Gate: mkimage bake green, kernel suite green (fileman legs
3/3), browser sweep 27/27.
