# 0384 — SysListView32 horizontal scroll (columns wider than the client clip today)

- **Status**: open
- **Design**: `todos/SOFTWARE-NATIVE.md` §3 (the 0370 control); filed from the
  0370 lane as a deliberate narrowing SURFACED, not silently cut.

## Goal

The 0370 report-view listview (`os/win32/listview.c`) scrolls vertically
through a real embedded SCROLLBAR child, but has no horizontal scroll: when
the summed column widths exceed the client width, trailing columns CLIP at
the right edge (per-cell ExtTextOut clipping — nothing is corrupted, just
unreachable). A real report view scrolls horizontally (Explorer details,
regedit). None of the current customers (software manager 0371, fileman
details 0106 migration, 0130 Default Programs) need it at their natural
window sizes — but a user shrinking a resizable listview window past its
column sum hits it immediately, and a header divider drag can push columns
past the edge from inside the app.

## Plan

- A horizontal SCROLLBAR sibling of the vertical one (SBS_HORZ; the same
  notify-only WM_HSCROLL plumbing lv_proc already uses for WM_VSCROLL),
  shown when `sum(cxy) > client width`.
- An `xoff` pixel origin applied to header segment layout AND row cell x
  positions (the header child must scroll in lockstep — Windows does this by
  making the header wider than the client and moving it left).
- HDN divider drags and LVM_SETCOLUMN width changes re-derive the range.
- lvtest legs: range appears/disappears with column widths, xoff shifts
  HITTEST's iSubItem mapping, header stays aligned.

## Acceptance

- Columns wider than the client are reachable by scrolling; header and rows
  stay column-aligned at every offset; the bar hides when columns fit.
- lvtest legs above green; the corner square where the two bars meet is
  dead space (the Windows look), not a third control.
