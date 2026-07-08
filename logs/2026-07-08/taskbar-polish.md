# 0031 — taskbar polish: clock, stable order, overflow

Landed `todos/0031`, three wm.c-local Win95-feel fixes. Image v24.

## What / how

- **Clock**: right-aligned `HH.MM` in a reserved `CLOCK_W` (45px) cell,
  `time()` + `localtime()` (this libc's `__timezone_offset` gives real
  local time) through the 5×7 font. draw_bar already redraws per frame,
  so "update on the minute" holds by construction — no dirty tracking.
- **Stable button order**: EV_DESTROYED now memmove-compacts `wins[]`
  instead of the `wins[i] = wins[--nwins]` swap-remove, so closing a
  middle window slides later buttons left instead of teleporting the
  last one into the hole.
- **Overflow**: `btn_width()` — BTN_W until the row would run past the
  clock, then `avail/nwins - GAP` (floor `BTN_MIN` 24). Drawing, label
  truncation, and click mapping all share it, and the draw loop
  additionally refuses to paint under the clock cell.

## Test notes (the discriminating setups)

- Swap-remove vs compaction is only observable with ≥2 windows AFTER the
  closed one: the e2e spawns FOUR winboxes, closes the second, then
  clicks button 5 — compaction puts the slid-left window there
  (unfocused → click focuses it); swap-remove puts the LAST one there
  (already focused → the click would minimize it). Either wrong outcome
  fails the flags assert.
- Overflow needs 9 windows at 1024px (923px of button space / 108 per
  button); the discriminator is a click in the CLOCK cell — shrunk
  buttons leave it empty (no-op), unshrunk it lands on button 8 (the
  focused window) and would minimize it.
- Clock digits assert as a black-pixel histogram over the clock cell
  (exact digits depend on wall time): headless via `wmctl shot` of the
  taskbar surface read back out of the user image, browser via
  getImageData over the composited canvas.
