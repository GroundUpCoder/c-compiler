# 0273 child (b) — term side scrollbar wired to the scrollback ring

Branch `term-scrollbar`, on top of v145's child (a) (history ring +
`view_off` + wheel/PageUp/PageDown + snap-to-live). This child adds the
interactive side scrollbar; children (c) menu bar and (d) settings are
separate later lanes.

## Design

### One model, no second position state

The scrollbar is a pure view + controller over (a)'s existing state:
`hist_count` (lines in the ring) and `view_off` (lines scrolled up from
the live bottom; 0 = live). All scrollbar interactions mutate `view_off`
through the same clamped paths the wheel/keys use (`scroll_view()` for
track paging; a direct clamped assignment for thumb drag, mirroring
`scroll_view`'s clamp). There is no scrollbar-side copy of the position —
wheel, keys, and bar can never disagree.

Mapping (macOS Terminal parity: position within history + live grid):

- `total = hist_count + rows` (every line the viewport can reach).
- Thumb height `th = max(SB_MIN, sh * rows / total)` — proportional to
  viewport/total, floored at `SB_MIN` (12 px) so a 2000-line ring still
  leaves a grabbable thumb.
- Thumb travel `travel = sh - th`; thumb top
  `ty = travel * (hist_count - view_off) / hist_count`. `view_off == 0`
  puts the thumb flush at the bottom (`ty + th == sh` exactly);
  `view_off == hist_count` puts it at the top. The drag inverse is the
  same formula solved for `view_off` with symmetric rounding.

### Reuse vs new — the call

The only scrollbar facilities in the tree are inside the win32 veneer:
user32.c's EDIT built-in bars (0210/0211) and the SCROLLBAR control. Both
are HWND/GDI/message-loop-coupled (HDC, FillRect, GetSysColorBrush,
WM_VSCROLL notify semantics) — term is a raw SDL+freetype kernel-C app
that links neither user32 nor gdi32, and pulling the veneer in for one
widget would be absurd. The genuinely shareable core across the two
worlds is ~15 lines of proportional-thumb arithmetic; a cross-world
header for that is scaffolding, not a facility (the two also *shouldn't*
converge visually — the win32 bar is Win95 chrome with arrow buttons and
a square thumb, this is a macOS-style overlay). **Call: term draws its
own bar in its existing pixel-painting idiom; no shared header factored.**
If a third non-win32 scrollbar consumer ever appears, factor then — the
math is trivially liftable.

### Overlay, not reserved columns

The bar is an 8 px **overlay** at the surface's right edge, full surface
height, alpha-blended over whatever is under it (integer blend, exact and
deterministic in headless shots):

- track: 25% toward mid-gray (over the black default bg → RGB 32,32,32 —
  visible but subtle);
- thumb: 75% toward light gray (→ ~150+ — clearly distinguishable from
  the track).

Reserving real columns instead would change `cols = surf->w / cell_w`
and break the 640x456 = 80x24 geometry contract baked into the window
size, tests, and user expectations — and macOS (the parity reference)
overlays too. The cost is that the last ~1 column's pixels are tinted
while history exists; the blend keeps them legible.

### Hidden when no history (the deliberate visibility call)

Visible iff `!on_alt && hist_count > 0`. **Hidden — not full-height
thumb — when there is no history**, because:

1. macOS overlay-scrollbar behaviour (nothing to scroll → no bar);
2. a no-history term renders **byte-identical to v145**, so every
   existing golden/shot assertion that never scrolls is untouched by
   construction.

No fade-out timer (macOS's "show while scrolling" transient): term is an
event-driven zero-wakes-when-idle app (0178) and a fade would add timed
wakeups and make renders time-dependent (nondeterministic shots). The bar
is persistent while history exists — that is the deterministic reading of
"appears when history exists".

The alt screen has no scrollback (vi/less own the viewport), so the bar
hides there; mid-drag alt-screen entry makes the drag inert (motion is
gated on visibility) rather than letting a drag write `view_off` under
an alt screen that must stay live.

### Interaction

- **Thumb press** → drag: grab offset recorded, motion maps pointer y
  back through the inverse formula, clamped to [0, hist_count].
- **Track press** → pages toward the click by `rows - 1` (one PageUp/
  PageDown), via `scroll_view()`.
- Presses in the bar region (when visible) never anchor a text
  selection; when the bar is hidden the region behaves exactly as before.
- **Output-snap vs drag**: (a)'s discipline — new output snaps the view
  live — is kept, with one narrow carve-out: while the thumb is *held*,
  output does not snap (it would rip the thumb out of the user's hand
  mid-drag; macOS holds too). On release the next output snaps as
  before. Keys still snap unconditionally (`handle_key` unchanged).
- Wheel/PageUp/PageDown behaviour from (a) is untouched; the bar simply
  re-renders from the shared `view_off`.

### Resize

Geometry is recomputed from `surf->w/h` every render and every hit test —
nothing cached, so drag-resize needs no scrollbar-specific handling.
(a)'s `view_off` clamp on resize already covers the model.

## Test plan

Extend `tests/kernel/test_term_e2e.js` with a `scrollbar` session (the
(a) `scrollback` session's probe style — full-ink marker row + seq flood,
`wmctl` injection, PPM shots):

- pre-flood: right-edge 8 px strip is pure background (bar hidden, ==0);
- post-flood: strip has ink; **bright** (>100) pixels — the thumb — sit
  at the bottom of the strip, none at the top (track-only);
- `wmctl down` on the thumb + `hover` to y=2 + `up`: the marker row
  becomes visible (drag drove the view to the oldest line) and the
  bright thumb is now at the strip's top;
- `wmctl click` on the track below the thumb: pages down one viewport —
  the marker leaves row 0 (track click pages toward the click);
- verified against (a)'s existing thresholds: the bar adds ≤ ~152 ink px
  to a row-0 band (track 8×19), keeping live rows well under the <500
  ceiling and marker rows well over >1000.

## Deferred (not cut)

- **Image version bump**: term.c is a baked seeded source; the bump is
  left to @master's merge/ship step (the (a) precedent — parallel lanes
  bumping `image.json` in-branch just manufacture merge conflicts).
  Visible fallback: a stale persistent browser image simply shows the
  v145 term until the bump ships; fresh bakes (tests, boot.js) pick the
  new term.c up immediately.
- **Browser-sweep leg**: the kernel e2e drives the full real pointer
  path headless (shots are bit-exact shm); os-term.mjs's bright-pixel
  minimums were audited to tolerate the bar. A dedicated browser
  scrollbar leg adds no coverage the kernel leg lacks — revisit with
  (c)/(d)'s sweep work if desired.
