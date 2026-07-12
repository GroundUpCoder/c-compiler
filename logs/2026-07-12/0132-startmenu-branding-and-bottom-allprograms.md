# 0132 follow-up — gucOS sidebar band + All Programs at the bottom

**Landed 2026-07-12** (same day as the 0132 single-column revert). A visual
follow-up the user asked for after seeing the single-column menu: a Win95-style
**gucOS branding band** down the left, and **All Programs moved to the bottom**
of the column (XP/Vista/7 layout). Plus a scoping answer on real icons →
filed as **todos/0157** (P1).

## What shipped (os/wm.c)

- **gucOS branding band** (`SM_SIDE_W` = 22, so the root is now **192×274**).
  A vertical navy→blue gradient down the left with "gucOS" drawn by the new
  `draw_text_vert_s` — the existing 5×7 bitmap font rotated 90° CCW, reading
  **bottom-to-top** (upright when the head tilts left, the Win95 sidebar
  convention). The item column, hit-test, grooves, cascade arrow, and search
  box all shift right by `SM_SIDE_W`; `SM_ROOT_W = SM_SIDE_W + SM_COL_W`, so
  the All-Programs flyout still hangs snugly off the column's right edge.
- **All Programs at the bottom.** `sm_rebuild_left` now emits pins → recents →
  (groove) Settings, Run… → (groove) **All Programs LAST**. Everything
  downstream finds All Programs by *kind* (not index), so the flyout anchor,
  keyboard (Up wraps to it), and hit-test auto-follow; the flyout cascades
  **upward** via `menu_open_col`'s work-area clamp when the row sits low
  (exactly Win7).

### The vertical-text gotcha (worth remembering)

Getting `draw_text_vert_s` right took empirical iteration, not derivation.
First attempt was mirrored (`u`→`n`, `S` reversed). I rendered the four
candidate transforms as ASCII in Node and matched a hand-rotated 'G' to find
the **true (non-mirrored) 90° CCW** mapping: `xx = bx + r, yy = by - c`. That
fixed the mirroring but the *order* read reversed ("SOCUG"). Confirmed by
rotating the actual screenshot 90° with `sips` — CW rotation (tilt head left)
showed the letters upright but reversed. Fix: draw **bottom-to-top** (first
char at the bottom, advance up), which reads "GUCOS" correctly when tilted
left. Lesson: for rotated bitmap text, verify orientation AND stacking order
against a real render — head-tilt intuition is unreliable.

## Icons (todos/0157, P1)

The user asked about a permissive icon set. There is **no icon-image path in
wm.c at all** today (desktop icons are a flat navy-square glyph; menu/taskbar
are text-only), so this is building the path, not swapping assets — a real
pipeline (rasterizer + loader/blitter + name→icon map). Recommended
**Pixelarticons (MIT)**: monochrome pixel-art that bakes into a C array like
the existing font, so the blitter reuses the font path. Real Win95 icons are
Microsoft-copyright — out. Filed as 0157 rather than squeezed in here.

## Tests

- `test_wm_service_e2e.js` + `os-shell.mjs` re-geometried to 192×274: new band
  pixel assert (blue gradient at x<22), All Programs hover/flyout at the bottom
  row (`AP_ROW`), Run… at column row 1, keyboard **Up** (not Down) to reach the
  bottom All-Programs, item pixel checks offset by `SM_SIDE`. Kernel wm_service
  green; all os-shell Start-menu legs green. Image `version` 76→77; WM.md +
  CLAUDE.md updated.
- **Zombie-server gotcha**: os-shell (port 3197) initially failed to boot — two
  `serve.js` processes from the earlier HEAD-worktree test (`/private/tmp/
  cc-head`, from attributing 0156) were still LISTENING on 3197, so the browser
  loaded the stale worktree. `git worktree remove` does NOT kill the detached
  serve.js it spawned. Killed them (`lsof -iTCP:3197`), boot recovered.
- The lone os-shell failure remains the **pre-existing** todos/0156 (49,52)
  desktop-icon rename leg — unrelated, still owned by that P0.
