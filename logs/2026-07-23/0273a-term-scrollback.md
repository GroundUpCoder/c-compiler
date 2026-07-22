# 0273a — term scrollback history ring

First child of the **0273** umbrella (term → macOS Terminal parity). Scope
here is child **(a) only**: a scrollback history ring with wheel + PageUp/
PageDown navigation and snap-to-live. Children (b) side scrollbar, (c) menu
bar, (d) settings window are separate later lanes — **not built here**.

## The problem

`os/term/term.c` kept only the visible `grid` (`rows*cols` cells). When a
line scrolled off the top of the screen it was discarded — no way to scroll
back up into output that had left the viewport.

## Design — a ring independent of the ANSI scroll region

The ANSI scroll region (`scroll_top`/`scroll_bot`, DECSTBM/IL/DL/SU) is an
*in-screen* VT100 concept. User-facing scrollback is a **separate** thing, so
it's a clean separate structure — not layered onto the scroll region.

- `HistLine { Cell *cells; int len; }` ring of `SCROLLBACK_MAX = 2000` lines
  (`hist[]`, `hist_head`, `hist_count`). Each line stores **its own captured
  width** (`len`).
- **Feed point:** only `linefeed()` scrolling the bottom row with the scroll
  region anchored at row 0 on the **main** grid pushes to history — i.e. a
  real terminal scroll. `scroll_up()` gained a `to_hist` flag; DL (`M`), IL,
  and SU (`S`) pass `0` so an editor's in-screen scrolling never pollutes
  history (xterm's rule). Alt screen never feeds it.
- **View offset:** `view_off` = lines scrolled UP from the live bottom (0 =
  live). Writing *always* targets the live grid regardless of `view_off`;
  only `render()` reads it. `view_row(vr)` maps each viewport row to either a
  history line (`live_r = -1`) or a live grid row.
- **Snap to live:** any new pty output (drain loop) and any non-scroll
  keypress (`snap_live()`) reset `view_off = 0` — Terminal behaviour.
- **Navigation:** wheel (`SDL_EVENT_MOUSE_WHEEL`, 3 lines/notch) and plain
  PageUp/PageDown (a screenful) on the main screen; alt-screen apps (vi/less)
  keep those keys for themselves. `scroll_view(delta)` clamps to
  `[0, hist_count]`.

### Resize behaviour (decided + documented)

History survives a resize **untouched**: each `HistLine` keeps the width it
was captured at and `render()` clamps to the live `cols`, padding absent
cells with the default background. **No reflow, no corruption** — the
simplest correct policy. rows changes don't touch history. (Reflowing
history to a new width is a macOS-Terminal nicety left for later; it is not
needed for correctness and would be a large, separate change.)

### Rendering correctness

`render()` was refactored to source each row via `view_row()`, and
`cell_colors()` now takes the *live* row index (or −1 for history) so the
cursor and selection only apply to live rows; selection highlighting is
gated to the live view (`view_off == 0`) since selection coords are
live-grid. **At `view_off == 0` the output is byte-identical to before** —
verified: all pre-existing term pixel legs (frames/vi/unicode/wide/less)
pass unchanged.

## RED→GREEN evidence

Probe: clear+home, print a full-width `#### … MARKER` line, then `seq 300`
floods it off the top so it becomes the *oldest* history line. Row-0 ink
cleanly separates the marker (~1960 px) from a live seq number (~139 px).

| shot | with ring (GREEN) | without ring (RED, stashed term.c) |
|------|-------------------|-------------------------------------|
| live | 139 | 139 |
| PageUp→top | **1960** (marker visible) | 139 (inert) |
| PageDown→live | 139 | 139 |
| wheel→top | **1960** (marker visible) | 139 (inert) |
| new output (snap) | 167 (live) | 167 |

Look-confirmed visually: live shows seq 278–300; the scrolled-up shot shows
the `MARKER` line + lines 1–23 (content that had left the viewport); the
snap shot jumped back to the live bottom after `echo`.

## Files

- `os/term/term.c` — the ring, `view_row`/`view_off`, wheel + PageUp/PageDown
  handling, snap-to-live, `scroll_up(to_hist)`, `render`/`cell_colors`
  refactor, resize + full_reset(RIS clears history) + enter_alt handling.
- `tests/kernel/test_term_e2e.js` — `sessionScrollback()` (5 shots: live /
  PageUp / PageDown / wheel / snap) + an optional argv session-filter
  (defaults to all, so the kernel runner is unaffected).

## Gate

All 7 `test_term_e2e.js` sessions green, run in four sub-600s batches
(term+frames, unicode+wide, nested+less, scrollback) — no regression, new
leg 6/6. Full browser sweep deliberately **not** run (600s ceiling).

## Not done (later 0273 children)

(b) side scrollbar, (c) menu bar, (d) settings window + persistence. No
`image.json` bump / no deploy — @master serializes the gucOS image (0273a
rides v145).
