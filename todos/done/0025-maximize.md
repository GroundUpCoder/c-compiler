# 0025 — maximize / restore

- **Status**: done (2026-07-08; dev log `logs/2026-07-08/maximize.md`).
  Decided in-item: `wmctl max` sends a new WMP ACTIVATE 0x18 which the
  kernel re-emits as EV_TITLE_ACTIVATE 0x8A — the double-click and the
  agent share ONE wm.c policy path; R_ERR with no subscriber (no WM =
  no maximize). The fixed-size branch reuses 0024's fit but suppresses
  the integer snap when it would overflow the work area. No maximized
  record-flag bit (the kernel keeps zero maximize state).
- **Depends**: 0021 (the resizable-flag dispatch); 0024 for the
  fixed-size branch (scale-to-fit). Ordered last — by then it's nearly
  pure policy.
- **Design**: `todos/WM.md` ("Screen, VTs, and scaling fixed-size
  clients" → maximize block). Precedent: Windows work area +
  greyed-out maximize box for fixed-size windows, EWMH
  `_NET_WM_STATE_MAXIMIZED`/`_NET_WORKAREA`,
  `xdg_toplevel.set_maximized` → configure → ack (exactly 0019's
  kernel-initiated resize shape).

## Goal

Double-click a title bar to toggle maximize. Resizable windows get a
real SURFACE_CONFIGURE to the work area (screen minus taskbar); restore
returns to saved geometry. Fixed-size windows get the 0024 scale-to-fit
(letterboxed dst) instead — same gesture, dispatched on flag bit4, like
Windows greying the maximize box but friendlier.

## Plan

- **kernel.js** (the only new mechanism): detect double-click on the
  title bar in the hit-test and emit it as a WMP event
  (`EV_TITLE_ACTIVATE` — mechanism in kernel, policy in WM). No kernel
  maximize state.
- **os/wm_proto.h + test_wm_policy.js**: the MUST-MATCH event.
- **wm.c**: per-sid saved geometry + maximized set. On activate:
  resizable → MOVE to work-area origin + RESIZE to work area (the WM
  already knows the work area — the taskbar is its own surface);
  fixed-size → SET_DST letterbox fit (0024). Second activate restores.
  EV_SCREEN (0023) while maximized → re-fit to the new work area.
- **Agent channel**: `wmctl max SID` toggling via the same policy path
  (send the activate through WMP, or a MAX command wm handles — decide
  in-item; the one-op-set rule prefers whichever keeps a single code
  path). Optional: maximized as a WMP record flag bit.
- No-WM fallback: no maximize (kernel chrome stays minimal — same as
  minimize today).
- Seeded wm.c/wmctl.c changes → image version bump.

## Acceptance

- Browser: double-click winbox/term title → fills work area (taskbar
  visible); double-click again → exact previous geometry. Double-click
  doom's title → letterboxed scale-to-fit, input still correct.
- Headless: scripted-WM test sees EV_TITLE_ACTIVATE; real-wm e2e drives
  maximize/restore via wmctl and asserts geometry + screenshot.
- A title-bar double-click never triggers on two slow clicks (define
  the interval; single-click drag behavior unchanged — 0013 suites
  green).
