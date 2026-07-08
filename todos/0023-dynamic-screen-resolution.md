# 0023 — dynamic screen resolution (full-viewport VT2)

- **Status**: open
- **Depends**: — (0022 landed; this is the prerequisite it deliberately
  scoped out)
- **Design**: `todos/WM.md` ("Screen, VTs, and scaling fixed-size
  clients" → dynamic screen resolution). Precedent: RandR screen-change
  events / Wayland `wl_output` — the display server owns the mode,
  everyone else gets an event.

## Goal

The screen stops being a boot-time 800×500 constant: the desktop canvas
tracks the browser viewport on VT2, the compositor and WM follow, and
windows never become unreachable after a shrink. This is the real fix
for windows larger than the screen (doom at `WINDOW_SCALE 2` = 1280×800
today) and the visible payoff of 0022's VT model.

Most of the mechanism exists: `wmSetScreen` is already re-callable (it
only writes `_wmScreen` + bumps `_wmVersion`), and the compositor reads
`canvas.width/height` fresh each frame — the gaps are the resize event
chain and that `/bin/wm` learns dims exactly once (SUBSCRIBE reply).

## Plan

- **os.html**: viewport resize listener → set the canvas's **natural**
  size (never CSS-scale — the "event offsets == screen coordinates"
  invariant must hold) → `{type:'screen-resize', w, h}` to the kernel
  worker. Decision: 1 CSS px = 1 screen px (ignore devicePixelRatio for
  now — DPR would put a scale factor on every coordinate path).
- **kernel-worker.js**: resize the OffscreenCanvas + re-call
  `wmSetScreen`.
- **kernel.js**: new WMP event `EV_SCREEN {w,h}` to subscribers, plus a
  one-shot position clamp (title bars reachable — the drag-clamp logic
  exists) so the **no-WM fallback** stays usable after a shrink.
- **os/wm_proto.h + test_wm_policy.js**: the MUST-MATCH event.
- **wm.c**: on EV_SCREEN update `scr_w/scr_h`, re-lay the taskbar
  (destroy + recreate the bar window — there is no client-initiated
  resize, by 0019's design), re-clamp windows. Policy: clamp, don't
  re-cascade (no placement churn).
- Seeded source changes → bump `os/image.json` version.
- boot.js: `wmSetScreen` callable headless already; cover EV_SCREEN +
  clamp in the kernel suite.

## Acceptance

- Browser: VT2's desktop fills the viewport; resizing the browser
  window resizes the screen live (taskbar re-lays, windows stay
  reachable); VT1 xterm behavior unchanged.
- Headless: `wmSetScreen` mid-session emits EV_SCREEN; a scripted WM
  sees it; shrink leaves no window with an unreachable title bar (with
  and without a WM connected).
- Existing browser suites green (they assume 800×500 boot geometry only
  where they must — audit `tests/browser/os-*.mjs` pixel probes).
