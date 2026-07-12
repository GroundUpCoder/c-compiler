# Notepad status-bar part text overflow (comctl32 clip fix)

Found by playing around in the OS: launched Notepad from the desktop and
its status bar read `Line 1, column 1 | Windows (CR + LF) | UTF-8` — but at
the default 400px window width the middle "Windows (CR + LF)" pane is wider
than its 120px cell, and its `LF)` tail was drawn **on top of** the "UTF-8"
pane (garbled `LĐTF-8`).

## Cause

`os/win32/comctl32.c` `sbar_proc` WM_PAINT drew each part's text with a plain
`TextOut(dc, left + 6, 3, t, strlen(t))` — no clip to the part rectangle. A
readout wider than its cell overflows into the next part. Real Win32 status
bars clip each part's text to its cell (text wider than the cell is simply
cut at the border).

## Fix

Draw with `ExtTextOut(dc, left + 6, 3, ETO_CLIPPED, &part, ...)` — `part` is
the per-cell rect already computed for the sunken-well edges, so the text is
clipped to its own cell. gdi32's `ExtTextOut` honours `ETO_CLIPPED` against
the passed RECT. One-line change, general across all part widths and window
sizes.

## Regression (test_notepad_e2e.js)

The existing checks only read the joined status-bar *text* (via `wmctl
gettext`), which can't see a visual overlap. Added a pixel check: shot the
untitled window (EOLN pane still the wide "Windows (CR + LF)") and sample the
6px band just right of the pane2|pane3 border (`width-120`). Pre-fix that
band held the bled `LF)` glyphs (~14 dark px); clipped it's 0. Assert
`bleed <= 2` and that the "UTF-8" pane still renders its own ink.

Bumped image `v83 -> v84` (seeded veneer binaries changed); also corrected
CLAUDE.md's version note, which had drifted to v82.
