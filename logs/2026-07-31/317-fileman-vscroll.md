# #317 — fileman: WS_VSCROLL on its listbox, and the latent layout bug it exposed

**The flag.** #275 taught the LISTBOX control to draw and drive a real
vertical scrollbar, but the bar is style-gated: `lb_sb()` in
`os/win32/user32.c` requires `(h->style & WS_VSCROLL)` before it shows
anything. fileman never asked for the style — its `g_list` creation had
zero hits for `WS_VSCROLL` — so the control that learned to scroll was
never told to have a bar. jku reported the missing bar and chose this
follow-on over waiting for the #150/0372 SysListView32 migration.

**The exposed bug: character columns under a proportional font.** The
first evidence shots showed row text clipped by the bar's left edge
(cairodemo's date lost its last glyph). Root cause was a FALSE premise in
the row builder's comment: "The mono font makes space-padding an honest
column". The stock font has been proportional since the C2 flag day, so
the `"%-28s %10s  %s"` layout bounded row width in CHARACTERS while paint
happens in PIXELS — a row's width grew with its name's letter count at a
fixed character count, pushing the date tail under the gutter. The
gutter didn't create the overflow; it just moved the clip edge inward
enough to make it visible on /bin. (`%-28s` also never truncates, so a
>28-char name always overflowed, scrollbar or not.)

Character-count truncation cannot fix that (28 W's and 28 i's are
different pixel widths), and the discriminator is glyph metrics, not
length: in the interim character-budget version of the fix,
`New Folder 2/` + `<DIR>` (13 chars, wide N/w/F/d glyphs) elided while
the longer `Copy of dfile.txt` + `1` (17 chars, narrow f/i/l/t) fit.

**The fix (fileman.c only): rows are laid out in pixels.** `row_fit`
measures with `GetTextExtentPoint32` — the same stock font the control
paints with; fileman never sends WM_SETFONT — composing each row as
name + computed space padding + a right-flushed "size  date" tail at the
usable width. The name is elided ("...") to the pixels the tail leaves;
`fit_tail` chops the row tail as the floor for degenerate widths. The
usable width always reserves the show-when-needed scrollbar gutter
(`SM_CXVSCROLL`), so the bound holds for any directory, any filename
length, any window width — by measurement, not by coincidence of /bin.
A side benefit: the stock digits are uniform-width, so the right-flushed
tails render as genuinely straight size/date columns for the first time.
`render_rows` (the LB rebuild from the `g_ents` snapshot) is now
separate from `refill` (the directory read), and `relayout` re-renders
on a list-width change with selection carried by name (the 0123 rule)
plus the scroll position. The false comment is retired; proper column
controls arrive with #150.

**Did relayout() need a change?** The control-placement math: no — the
#275 bar draws inside the control over a reserved gutter (clip, row
rects, and hit-testing all subtract it in user32). But the ROW CONTENT
is width-dependent now, so relayout gained the re-render hook; "the
layout" in the wider sense did need one, and the first shots are why.

**Evidence** (`tools/os-drive-scripts/fileman-vscroll-shots.mjs`, real
browser boot, shots in `logs/2026-07-31/0317-fileman-vscroll/`):
`fileman /bin` (135 objects vs ~9 visible rows) shows the bar with a
proportional thumb; ten down-arrow clicks scroll ten rows with the thumb
tracking; a 300px resize elides names per their measured widths while
the size/date column stays intact and clear of the bar.

Image bumped 205 → 206 (shipped-behaviour change; #312 deployed 205).
