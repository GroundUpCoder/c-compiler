# term Settings pane: measured row geometry (#363), then the Autoscroll row (#358)

One lane, in that order, because both tickets rewrite the same constants
(`SET_H` / `SET_BOX_H` / `SET_ROW_H`), the same `settings_paint` loop, the same
`settings_mouse` hit test and the same e2e size assertion. Run as two lanes the
second would rebase onto constants the first had just moved.

## #363 — the box was 6px shorter than the text it contained

`settings_paint()` drew every string with `TextOut(..., y + 3)` into a box of
`SET_BOX_H` 22. The stock UI font is 20px with a **28px** text cell
(`ascent + descent`, gdi32.c), and `TextOut`'s `y` is the **cell top**, so:

```
box      y .. y+22
text     y+3 .. y+31      <- 9px of overflow
baseline y+25             <- 3px BELOW the bottom border of its own box
```

Nothing truncated it (`SetBkMode(TRANSPARENT)` + a DC clip covering the whole
window), so descenders landed on BTNFACE, the Theme row's value escaped its own
swatch mid-glyph, and — because `settings_mouse()` hit-tested the same 22px box
— the visible bottom third of every row was **dead to the pointer**.

Those 22 and +3 are Win95-at-96dpi numbers for a ~13px system font. The pane was
written three days after the 20px-chrome layout re-tune (`c95dbdb1`) and picked
its constants by hand; a manual sweep cannot protect code that does not exist
yet. Broken since `1a16e50f` (2026-07-23), shipped in every image through 214.

**Fix: measure, don't guess.** `set_measure()` takes `GetTextMetrics().tmHeight`
off a 1x1 memory DC — which carries the same `SYSTEM_FONT` the pane's screen DC
gets from `dc_defaults`, so it works *before* the window exists, which it must,
since the window height is one of the derived numbers. Everything falls out of
it: `set_box_h = tmHeight + SET_BOX_PAD(4)`, `set_row_h = set_box_h +
SET_ROW_GAP(12)`, `set_win_h = SET_TOP + SET_N_ROWS * set_row_h + SET_BOT`.
`settings_mouse()` reads the same two variables, so the hit region IS the drawn
box by construction. Text goes through one `set_text()` helper using
`DrawText(DT_SINGLELINE|DT_VCENTER|DT_NOPREFIX)`, which also **clips to the
rect** — ink cannot escape a box even if a future string outgrows it.

🔴 **Growing the box is the load-bearing half.** `DT_VCENTER` alone still
overflows a 28px cell out of a 22px box by 3px each side. The measurement is
what fixes it; the centering is what keeps it pretty.

Measured result at the stock font: cell 28 → box **32**, pitch **44**, window
**300x286** (was 300x192). The pane is now font-size-agnostic, which term of all
apps wants — it ships a Font Size setting.

No new API and no new linkage: `os/term/bin.json` deps `../win32/menucore.json`,
whose sources include `gdi32.c`, so `DrawText`/`GetTextMetrics`/
`CreateCompatibleDC` were already linked into term. The primitive was one call
away the whole time. The first read of this bug called them "unreachable" — that
was wrong, and checking `bin.json` instead of believing it is the lesson.

## #358 — the sixth row, and the count that was spelled out six times

`autoscroll` (#354) was config-key-only: `~/.config/term` accepted it and
nothing in the UI mentioned it. jku, by email 2026-08-01: *"Definitely want auto
scroll to be discoverable in the settings panel of term."*

Everything except the row already existed — `ONOFF_NAMES` (which already PARSES
this key), the live `autoscroll_on` global, the `default 1`, and the `cfg_apply`
FS_WATCH repaint. So the row reads `ONOFF_NAMES[autoscroll_on]` and writes the
same key through the same `set_persist` delta-write. **No second key, no second
table, no second default.**

The count was hardcoded in six places, two of which fail silently (a missed
`SET_H` draws the row outside the window; a missed `settings_mouse` bound paints
a row that does nothing). It is now derived from `SET_LABELS` once:

```c
#define SET_N_ROWS ((int)(sizeof SET_LABELS / sizeof SET_LABELS[0]))
```

threaded through the window height, the paint loop and the hit test — a seventh
row is one edit.

**A third silent failure the ticket did not name.** `settings_paint` declares
`char val[40]` ONCE outside the loop and `set_row_value` had no `default:`. A
missed `case 5:` would therefore render **row 4's value verbatim** — "sound"
sitting in the buffer, plausible, and indistinguishable from success in a
screenshot. Both switches now carry a loud `default:` (`"?row N?"` in the value,
a stderr line in the adjust).

The row is APPENDED, not inserted: `settings_paint`'s `int num = i == 0 || i ==
2` picks stepper-vs-cycler by hardcoded index, so appending lands autoscroll on
the cycler branch — correct by the append, and an insert anywhere else would
have silently mis-shaped Font Size or Scrollback.

## The gate that would have caught #363, and its red control

The existing pixel leg asserted `darkInk(whole pane) > 150`. Text that had
ESCAPED its box satisfied that **better** than correct text did — which is
exactly why a 9px overflow shipped for ten days. Replaced the missing invariant
with containment: **zero dark ink in the top margin, the six inter-row gutters,
or the bottom margin**. The box frames are BTNSHADOW `0x808080`, above the
`< 100` ink threshold, so this counts glyph ink only.

The Font Size click moved to **y=40** — offset 28 into row 0's 32px box, inside
the drawn ink but past the old 22px hit test's edge. It is the positive control
for the dead zone, not a convenience coordinate.

Both were verified as **red controls**, not assumed. Restoring the original
geometry (`SET_BOX_PAD -6` → a 22px box, `TextOut(y+3)`) and re-pinning the test
constants to 22/34 reproduces the shipped bug and turns exactly four checks red:

```
FAIL settings: Font Size + at the box BOTTOM (y=40) re-sized the live window off 640x486
FAIL settings: user layer persisted fontsize 15
FAIL settings: relaunch equals the live-applied geometry (fontsize persisted)
FAIL settings: no glyph ink outside a row box   34..46:152 68..80:60 102..114:240
                                                136..148:149 170..182:139 204..216:145
```

885 ink pixels in all six gutters, and the bottom-third click rejected. Both
gates detect the exact defect they were written for.

## #358's read-back leg

Acceptance wanted persistence proven in **both** directions and the new row
proven **clickable**, not merely rendered. One leg does all three: after the
pane writes `autoscroll off` and term is relaunched, the reopened pane gets one
more `>`, and the config must then read `autoscroll on`. Had the row not tracked
the persisted value it would have started from the default `on` and written
`off` — the two outcomes are distinct, which is what makes the config file a
sufficient observable without reading pixels for text.

## Not done here

`os/image.json` is deliberately NOT bumped — a one-row UI change rides the next
image bump (standing gucOS bundle rule).

The framework half of the analysis (`~/git/meta/gucos/notes/`,
recommendation 2 — lift `wm.c`'s cap-relative `draw_text_s` into a shared
`ui_text_in_box()` next to `fontcore.h`/`menucore.h` and reseat `wm.c`,
`term.c` and `software.c` onto it) is **not** in this lane. term now has a
local `set_text()` that does the right thing; the shared primitive that would
make the *next* hand-drawn pane correct by default is still owed, and
`software.c`'s header collision (recorded in #283) is still open.
