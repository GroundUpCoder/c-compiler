# 0168 — wm.c goes event-driven: WaitEventTimeout loop + WMP-socket wake + taskbar present gate (IDLE-POWER Stage 3)

- **Status**: open
- **Design**: `todos/IDLE-POWER.md` (pieces W + D). Absorbs the taskbar-gate
  half of todos/0160 (the reverted attempt's `bar_present()` memcmp,
  recoverable from commit `659902d`).

## Goal

/bin/wm is the only always-running SDL app on an idle desktop and is a
frame-callback app (`__setAnimationFrameFunc(frame_cb)`, os/wm.c ~3767) —
as long as it wants a frame every tick, the 0169 compositor can never park,
and a parked system would break wm's own duties (the screensaver's 1 Hz
GET_IDLE poll rides frame_cb: idle is exactly when it must fire; ditto the
clock and the desk_load/recycle-glyph coarse polls). Convert wm.c to the
0161 `SDL_WaitEventTimeout(…, 1000)` idiom and gate the taskbar present on
content change.

## Plan

- **Kernel prerequisite (in no earlier item): WMP-socket→input-ring wake.**
  `pumpWait` parks on the input ring only (host.js ~6036); wm's events
  (EV_CREATED, EV_SNAP_EDGE during a foreign title drag, EV_SCREEN, R_IDLE)
  arrive on the AF_UNIX socket. Kernel socket delivery to a wait-parked
  subscriber must notify its ring or the taskbar/snap preview lags up to
  1 s. (Precedent: user32's GetMessage chunks `__sdl_pump_wait(25)` for
  exactly this; this plumbing eventually lets user32 stop chunking — out of
  scope here.)
- wm.c `frame_cb` → a WaitEventTimeout(1000) loop: socket drain on wake;
  frame-tick counters (desk_load, saver poll, PEEK_IDLE/PEEK_REFRESH
  ~wm.c:237) converted to wall-clock; menu/ctx/run columns redraw on state
  change instead of every frame (today only `draw_desk` is dirty-gated);
  screensaver marquee/starfield and other wm-rendered animations stay
  frame-paced while active (they are ordinary presents, per the IDLE-POWER
  wake table).
- Piece D: `bar_present()` content gate (clock digit / button set / overflow
  state) — recover from `659902d`.

## Acceptance

- Idle desktop: wm wakes ≤1/sec (wake counter once 0169 lands; until then,
  strace/timer instrumentation), clock still ticks each minute, screensaver
  still raises after the idle timeout, dropped/created Desktop files still
  appear within a poll interval.
- Full wm e2e surface green — this is the risk concentration:
  test_wm_service_e2e, test_snap/saver/ctxmenu/recycle/fileman_ops e2es +
  the os-wm/os-shell/os-saver/os-snap/os-ctxmenu browser legs.
- `node tests/flake.js` (frame-loop + input-wake change).
