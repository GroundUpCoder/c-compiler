# #317 — fileman: WS_VSCROLL on its listbox (the #275 follow-on)

**One-line fix.** #275 taught the LISTBOX control to draw and drive a real
vertical scrollbar, but the bar is style-gated: `lb_sb()` in
`os/win32/user32.c` requires `(h->style & WS_VSCROLL)` before it shows
anything. fileman never asked for the style — its `g_list` creation had
`WS_CHILD | WS_VISIBLE | LBS_NOTIFY | LBS_EXTENDEDSEL` and zero hits for
`WS_VSCROLL` in the file — so the control that learned to scroll was never
told to have a bar. jku reported the missing bar and chose this one-liner
over waiting for the #150/0372 SysListView32 migration (which will replace
the control entirely; nothing here is wasted, it's a style flag).

**Why no layout change is needed.** The #275 bar is drawn *inside* the
control over a reserved gutter (the 0210 EDIT pattern): the paint path
computes `gut = lb_sb(...) ? EDIT_SB_W : 0`, clips item text with
`IntersectClipRect(dc, 2, 2, h->w - 2 - gut, ...)`, narrows row rects by
`gut`, and hit-testing excludes the gutter column. So fileman's
`relayout()` is untouched — item text clips short of the bar, never under
it. Verified in the evidence shots (long size/date lines cut cleanly at
the gutter edge).

**Evidence** (`tools/os-drive-scripts/fileman-vscroll-shots.mjs`, real
browser boot): `fileman /bin` (135 objects vs ~12 visible rows) shows the
bar — up arrow, proportional thumb, channel, down arrow at the listbox's
right edge; ten `wmctl click` hits on the down arrow scroll the view ten
rows (`[`/`awk`/`base64` → `clip`/`cmdalt`/`cmp` at the top). Shots in
`logs/2026-07-31/0317-fileman-vscroll/`.

Image bumped 205 → 206 (shipped-behaviour change; #312 deployed 205).
