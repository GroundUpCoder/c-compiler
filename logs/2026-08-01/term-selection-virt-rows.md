# #355 — term selection moves to virtual (content) rows

## The bug

Selection (todos/0090) predates scrollback (0273a). The mouse handlers
stored the VIEWPORT row as a live-grid row, `view_off` appeared nowhere in
the selection math, and the renderer's `show_sel = (view_off == 0)` gate
merely hid the highlight while scrolled — so a drag over a scrolled-back
line rendered nothing and Ctrl+Shift+C silently copied the live bottom
rows. Silent wrong bytes, hence P0.

## The fix — one coordinate space, the renderer's

`sel_ay`/`sel_ey` are now VIRTUAL line indices, exactly the space
`view_row()` already computes: `virt = hist_count - view_off +
viewport_row`, `[0, hist_count)` history (oldest first), `[hist_count,
hist_count + rows)` the live grid. No parallel coordinate system.

- Mouse anchor/extend add `hist_count - view_off`. `sel_has` takes virt
  rows; `cell_colors` gets the virt row (live_r stays for cursor logic);
  the `show_sel` gate is DELETED — the highlight renders while scrolled.
- `copy_selection` resolves each virt row: history line (its own captured
  width; cells past it read as blanks and trim) or live grid row.
- Content anchoring falls out: `hist_push` moving a live line into
  history does not change its virt index, so the highlight follows its
  text — the xterm behaviour the 0090 header comment always CLAIMED. On
  ring eviction every virt index shifts down one: `sel_evict(n)` shifts
  the anchors and clears the selection when its content is evicted
  (also called from `sb_set_max` for a live shrink — same invariant).
- `hist_clear` (RIS, Clear Scrollback) clears the selection: the anchors
  just dangled. `apply_resize` already cleared (cols-based linear bounds
  don't survive a resize) — unchanged.
- Snap guard: `!sel_drag` joins `!sb_drag` on the output-snap line (held
  out of #354 deliberately; folded in here). Mid-drag output can no
  longer yank the view — and because anchors are virt, even the
  autoscroll-off scrolled case keeps selecting the same content while
  output floods (hist_push's #354 content anchor moves `view_off` and
  `hist_count` in lockstep, so the mapping is stable).

## Two sites the ticket's list missed

- **CM_SELALL** (Edit > Select All) also stored viewport rows; unconverted
  it would have selected the OLDEST HISTORY lines once scrolled. Now maps
  the visible viewport into virt space (semantics preserved: it selects
  what's on screen).
- **handle_key snapped on EVERY key**, including bare modifier presses
  (SDLK_LCTRL falls through to `snap_live()`) and the copy chord itself.
  So even with correct copy bytes, pressing Ctrl to begin the chord
  yanked a scrolled view live — the feature would still LOOK broken
  interactively. Pure modifier keysyms (LCTRL..RGUI) are now inert, and
  KA_COPY resolves BEFORE the snap (copying what you scrolled to see must
  not scroll you away from it); KA_PASTE types into the pty, so it keeps
  snapping like any key. compiler.js's SDL veneer header gained the
  missing `SDLK_LGUI`/`SDLK_RGUI` defines (standard SDL3 values) so the
  range is nameable.

## Test

`test_term_e2e.js` session `selscroll`, committed RED first (c057a5e4):
X1 scrolled drag+copy returns the marker (was "278", a live seq digit)
and renders inverted cells (was pre==sel ink 794); X2 a live selection
follows its content into history across pushes and clears on eviction
(sentinel-in-slot proves the chord no-op); X3 RIS drops the selection.
Regression sessions unicode/wide/scrollback/autoscroll/scrollbar re-run
green against the fix.

No image.json bump in this lane — the master bumps once when shipping
the bundle.
