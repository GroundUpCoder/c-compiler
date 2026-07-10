# 0069 — WM map-on-placement: no first-frame teleport

- **Status**: DONE 2026-07-10 — kernel.js map-on-placement (+ the
  compositor/hit-test skips), zero wm.c change; dev log
  `logs/2026-07-10/wm-map-on-placement.md`. Decisions that stand:
  map ack = the WM's first geometry/STACKING op (MOVE/RESIZE/SET_DST/
  SET_LAYER/RESTACK, no-ops included; FOCUS/MINIMIZE don't map);
  borderless dispatches on subscriber ownership (foreign → mapped at
  create, the WM's own furniture → waits for its self-park); 200ms
  WM_MAP_TIMEOUT_MS backstop + last-subscriber-gone map everything
  pending; the 80-byte WMP record is UNCHANGED (`wmList` carries the
  `mapped` flag instead); SURFACE_RESIZE (owner op) does not map.
- **Design**: `todos/WM.md` (WMP protocol block; known-issues entry
  retired with this item)

## Goal

New windows visibly TELEPORT: every surface — app windows AND the wm's
own furniture (start menu most jarringly) — renders for a few frames at
the kernel's cascade default before jumping to its real spot. Fix by
the classic X11/Wayland answer: a surface managed by a WM is not
composited (not "mapped") until the WM has placed it.

## Root cause (verified 2026-07-10)

- `kernel.js` `SURFACE_CREATE` assigns a sid-derived cascade default
  position, pushes the surface into the z-order, and bumps
  `_wmVersion` immediately — the very next compositor pass draws it
  (chrome + buffer) at that default.
- `/bin/wm` is an async AF_UNIX peer: it only learns of the window via
  `EV_CREATED`, then answers with `WMP_MOVE` (`place()` cascade for app
  windows at `os/wm.c:694`; edge-park for its own startmenu/taskbar/
  desktop at `os/wm.c:644-677`). That round trip crosses two workers
  plus wm's poll loop — easily ≥1 rAF, so the wrong-position frames are
  guaranteed, not a race we might win.
- The start menu is the worst case because its kernel default (top-left
  cascade) is maximally far from its parked spot (bottom-left, above
  the bar), and it's opened by a click the user is watching.

## Plan

- Kernel: when a WMP subscriber exists at `SURFACE_CREATE`, create the
  surface `mapped: false`; both compositor flavors (browser
  `os/compositor.js` pass + kernel-chrome/`wmctl shot` path) and input
  hit-testing skip unmapped surfaces. No subscriber → mapped
  immediately (the no-WM fallback keeps today's behavior exactly).
- Map trigger: the first WM-initiated geometry/stacking op on that sid
  (`MOVE` covers everything wm.c manages today — it MOVEs every window
  incl. furniture on `EV_CREATED`). Decide whether borderless windows
  the wm deliberately ignores (`WMP_F_BORDERLESS` early-return,
  `os/wm.c:680`) need an explicit `WMP_MAP` op or are simply
  kernel-mapped at create (they're taskbar-class, owner-positioned).
- Backstop: a short timeout (a few frames / ~200ms) maps the surface
  anyway so a wedged or killed-mid-create wm can never hide windows;
  wm death (existing subscriber-drop path) maps all pending too.
- wm.c likely needs zero changes for the common path — the MOVE it
  already sends becomes the map ack.
- Tests: kernel unit leg (create-with-subscriber → not in scene until
  MOVE; timeout backstop; no-subscriber unchanged) + a browser leg
  asserting the start menu's first composited position IS the parked
  position (no top-left flash). Audit existing tests that create a
  window then immediately screenshot/hit-test — they may now need to
  await the map.

## Acceptance

- Opening the start menu / launching a GUI app never shows a frame at
  the cascade default; the first visible frame is at the WM-placed
  position (browser test asserts it).
- Killing the wm between create and place still shows the window
  (backstop test).
- No-WM boots (kernel-chrome fallback) byte-identical in behavior.
- Kernel + browser suites green; WM.md known-issues entry retired.
