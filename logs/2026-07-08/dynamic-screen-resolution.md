# 0023 lands — dynamic screen resolution (full-viewport VT2)

The screen stops being a boot-time 800×500 constant. On VT2 the desktop
canvas tracks the browser viewport; the compositor, the WM protocol, and
/bin/wm all follow; a shrink can no longer strand a window out of reach.
Design: WM.md "Screen, VTs, and scaling fixed-size clients" → dynamic
screen resolution. Precedent deliberately copied: RandR screen-change
events / Wayland `wl_output` — the display server owns the mode,
everyone else gets an event.

## Shape

- **os.html** measures the `#desktop` pane on VT2 entry and on debounced
  (150ms trailing) window resizes while on VT2, and ships
  `{type:'screen-resize', w, h}` to the kernel worker. Decisions:
  - **1 CSS px = 1 screen px** (devicePixelRatio ignored — a scale
    factor would taint every coordinate path; revisit with 0024's dst
    rects if ever).
  - **Natural canvas size only** — the "event offsets == screen
    coordinates" invariant survives untouched. A *transferred* canvas
    can't be resized from the page (the placeholder's width/height
    setters throw), which is WHY the resize rides a message: the
    **worker** resizes the OffscreenCanvas. The placeholder's layout
    rect then follows the committed bitmap automatically.
  - VT1 resizes still only re-fit xterm; the screen is untouched until
    the next VT2 entry (the pane is measurable only while visible —
    display:none reads 0×0).
- **kernel-worker.js** keeps the canvas ref from `wm-canvas`; on
  `screen-resize` it sets `canvas.width/height` and re-calls
  `wmSetScreen` — the compositor reads `canvas.width` fresh per rAF, so
  no compositor change at all.
- **kernel.js `wmSetScreen`** is now the real modeset: early-return on
  same dims, else update + `_wmVersion++`, emit the new WMP event
  **EV_SCREEN {w,h} (0x87)** to subscribers, then a **one-shot position
  clamp** over non-borderless surfaces (the existing drag-clamp bounds:
  x ∈ [40−w, W−40], y ∈ [TITLE_H, H−8]) emitting EV_MOVED per moved
  surface. The kernel clamps so the **no-WM fallback** stays usable
  after a shrink; borderless surfaces are skipped (no title bar to keep
  reachable — placement is WM policy).
- **/bin/wm** now tracks geometry (EV_CREATED record + EV_MOVED +
  EV_CONFIGURED → win_t x/y/w/h) and on EV_SCREEN: updates scr_w/h,
  re-lays the taskbar by **destroy + recreate** (there is no
  client-initiated resize, by 0019's design — the recreated bar's own
  EV_CREATED parks it at the new bottom edge through the existing
  own-pid branch), **restores the focus the create stole** (surface
  create focuses; without this a mere browser resize would defocus the
  user's app), then re-clamps windows with its taskbar-aware bounds
  (y ≤ H−BAR_H−8). Policy: clamp, never re-cascade — no placement churn
  on a resize.
- **wm_proto.h / test_wm_policy.js**: WMP_EV_SCREEN in the MUST-MATCH
  set. SUBSCRIBE's R_OK dims are now just the *initial* mode.
- **image.json v16 → v17** (wm.c/wm_proto.h are seeded).

## Ordering notes (for future readers)

- Kernel emit order on modeset: EV_SCREEN first, then the clamp's
  EV_MOVEDs — a subscriber knows the new dims before it sees moves.
- Both kernel and wm clamp; the wm's MOVEs land after the kernel's
  clamp, so the final geometry is the wm's (stricter, taskbar-aware)
  when a WM runs, the kernel's otherwise. Converges deterministically
  because replies/events are strictly ordered per connection.
- The wm's EV_SCREEN handling runs in its frame callback, so window
  placement latency grows by a beat while the bar recreates — that
  surfaced a pre-existing test race (below).

## Test fallout (the 800×500 assumptions audit)

- `tests/browser/os-wm.mjs` / `os-vt.mjs` had hardcoded screen-edge
  probes (taskbar row 486, teal at (780,440)); they now wait for the
  VT2-entry resize to settle (canvas layout rect == `__osScreen`, the
  new page probe) and derive edge geometry from the live size. Sample
  helpers size their temp canvas from `getBoundingClientRect()` — the
  width/height *attributes* of a transferred placeholder go stale.
- os-doom/os-quake/os-term/os-gpubox got an explicit settle-wait after
  their first VT2 entry: they capture the canvas rect for mouse
  coordinates, and the canvas origin moves when the 800×500 canvas
  stops being centered in the pane (it now fills it).
- **os-gpubox flake found and fixed**: its cube-composited wait could
  break while the window still sat at the kernel-cascade spot (wm
  placement is an async MOVE), then the corner probe sampled desktop
  teal. Pre-existing race, widened by the EV_SCREEN work in the wm's
  frame loop. The wait now also requires the corner to be the render
  clear color, i.e. placement settled.
- New acceptance: `tests/browser/os-screen.mjs` (16 checks) — VT1
  resize doesn't touch the screen, VT2 entry re-modes to the pane, live
  grow re-lays the taskbar, park-then-shrink re-clamps winbox to
  exactly (W−40, H−36) via `wmctl list`, shell alive throughout.
  Headless: EV_SCREEN/clamp/no-op/no-WM legs in `test_wm_policy.js`.

All green at landing: unit 697✓ (3 pre-existing skips), host✓, blockfs✓,
kernel suite✓, browser os-boots✓ os-wm✓ os-vt✓ os-doom✓ os-quake✓
os-gpubox✓ os-term✓ os-screen✓ (run serially).
