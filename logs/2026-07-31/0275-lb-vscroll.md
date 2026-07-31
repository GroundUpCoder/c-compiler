# #275 — LISTBOX WS_VSCROLL: a real built-in scrollbar

The win32 LISTBOX accepted `WS_VSCROLL` and silently ignored it: no gutter, no
bar, no thumb — wheel/keys could scroll, mouse users could not (the original
user report was fileman; the pitch surface is calc's stats box, since 0372
moves fileman to SysListView32). This lands the bar as **0210's built-in
pattern**: drawn inside `lb_proc`'s own `WM_PAINT` over a reserved
`EDIT_SB_W` gutter — NOT a standalone SCROLLBAR child (binding call in the
ticket; listview.c's embedded child is the *other* precedent and stays).

## Shape

- `lb_sb()` — show-when-needed: the bar and its gutter exist only while
  `n > lb_rows()`. No `LBS_DISABLENOSCROLL` consumer in-tree.
- `lb_sb_geom()` — the 0210 geometry verbatim: [up arrow][channel with
  proportional thumb][down arrow] inside the 2px well; thumb
  `chan*rows/n`, min 8px.
- `lb_vscroll()` — THE one clamp (`lb_maxtop` = `n - lb_rows()`). The wheel
  case, the keyboard path (via `lb_show_sel`), the bar, `WM_VSCROLL`,
  `LB_SETTOPINDEX` and `SetScrollPos` all drive `st->top` through the same
  truncating range, so the thumb cannot desync from the wheel/key clamp —
  the acceptance's sync requirement, held structurally. (`lb_rows()`
  truncates and the stats box carries `LBS_NOINTEGRALHEIGHT`, so a partial
  last row exists; the range must come from `lb_rows()` or the thumb and
  the 4857-clamp disagree.)
- Hit-testing in `WM_LBUTTON*`: arrows ±1 row, channel = ±page, thumb drag
  via `SetCapture` + `WM_MOUSEMOVE` (the EDIT sbDrag shape). New
  `WM_LBUTTONUP`/`WM_MOUSEMOVE` cases; `LB_ITEMFROMPOINT` counts the gutter
  as outside.
- The classic contracts, since the surface naturally pertains:
  `WM_VSCROLL` (SB_LINEUP..SB_BOTTOM/THUMBTRACK), `LB_GETTOPINDEX` /
  `LB_SETTOPINDEX` (new in windows.h), and the Get/SetScroll* plumbing grew
  `SBTGT_LB_V` (style-gated like the EDIT targets — the bar EXISTS with the
  style; show-when-needed only hides pixels). A bar-less LISTBOX still
  fails loud (the 0211 contract; ctldemo's probe unchanged).

Consumers: calc's stats box (`en-US.rc:294`) starts working with zero calc
changes; ctldemo's main listbox grew the style + its `sel=` print now
carries `top=` (the e2e observable); ctldemo selftest grew 12 programmatic
checks (68 total, 0 failed in-OS).

## Tests

- **`tests/kernel/test_lb_vscroll_e2e.js` (new, registered in run.js)**:
  show-when-needed pixel legs (white well at 3 items → gray channel/arrow
  ink at 8), arrows/channel/thumb-drag/wheel/keys through the REAL input
  path (`wmctl click/drag/hover/wheel/key`), each step verified end-to-end
  by clicking a visible row and reading `sel=N top=M` — the ordered chain
  also pins the channel-page clamp at maxTop=3 (the truncation) and a
  pixel scan pins the thumb bevel to the key-scrolled position.
- **`test_calc_e2e.js` grew the #275 leg**: Sta reachable in scientific
  mode, six data points, the down-arrow click scrolls so the first visible
  row selects item 1 (pre-#275 the same click selects item 0), plus layout
  integrity (no stat-dialog control clips the 448x297 surface, no
  overlaps) — the check C2 handed down as unmeasured.

## Fallout found while looking (filed, not fixed here)

The C2 handoff explicitly asked this lane to LOOK at calc's scientific
layout (C2 re-pinned 869x570 by arithmetic; no screenshot existed). First
visual: `logs/2026-07-31/0275-lb-vscroll/calc-scientific-clip-evidence.png`.
Two pre-existing P0s, both root-caused line-precise:

- **#310** — `GetWindowRect` (client) vs `MoveWindow` (surface) lose
  `MENU_BAR_H` per round-trip; calc's WM_INITDIALOG restore shrinks every
  recreated dialog 30px → the bottom keypad row clips (client 540, Dat row
  bottom 553). The pinned 869x570 is itself the post-shrink size.
- **#311** — win32rc drops a bare `NOT WS_VISIBLE` style expression (and
  can never clear a control-keyword default bit), so calc's Dword/Word/Byte
  radios paint over Degrees/Radians/Gradians.

The stats box itself is clean — bar drawn, scrolled view correct
(`calc-statbox-scrollbar.png`), no clipping, no overlaps.

Image v202 → v203 (user32/ctldemo are baked sources).
