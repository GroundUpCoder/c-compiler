# 0102 — window system menu + keyboard move/resize (Alt+Space)

- **Status**: open
- **Design**: `todos/WM.md` (chrome policy: the kernel owns drag/close;
  wm.c owns policy — todos/done/0025's EV_TITLE_ACTIVATE split is the
  template). Filed by the 0076 parity sweep. Sequenced after 0091 to
  reuse its wm.c popup-menu look; the *chord* plumbing is independent.

## Goal

The classic window system menu is entirely absent: no Alt+Space, no
right-click-title-bar menu, no GetSystemMenu/WM_SYSCOMMAND in user32,
and no keyboard path at all to move or resize a window (kernel drag is
pointer-only — 0076 survey). Win95 gives every window Restore / Move /
Size / Minimize / Maximize / Close, and Move/Size then run as arrow-key
modes. This is the accessibility story for window management, and pairs
with 0095's Win+arrow snap chords.

## Plan

- **Chord** — Alt+Space at the kernel `wmKey` seam, the EV_CYCLE/EV_MENU
  pattern exactly: subscriber-gated, keyup swallowed, no-WM
  pass-through. New WMP event (EV_SYSMENU) carrying the focused sid;
  MUST-MATCH trio (kernel.js OP map ↔ os/wm_proto.h ↔
  test_wm_policy.js). Right-click on the title bar can emit the same
  event (kernel chrome hit-test already knows the title region) —
  decide there or defer to keep this keyboard-only.
- **Menu** — wm.c policy: a borderless popup at the window's top-left
  (0091 primitive/look) listing Restore/Move/Size/Minimize/Maximize/
  Close, rows enabled per the window's resizable bit + maximized state
  (wm.c already tracks both, 0025).
- **Move/Size modes** — wm.c-side state machine: after choosing Move
  (or Size), arrow keys nudge (say 8px; Enter commits, Esc reverts to
  the stashed rect) via ordinary MOVE/RESIZE ops; wm.c already receives
  keys while its furniture is focused (the 0078 root-column precedent —
  route by mode, not windowID). Size on a fixed-size window is disabled
  (scale stays a pointer affordance, 0024).
- Close/Min/Max rows reuse the existing chrome ops (wmClose path,
  wmMinimize, the 0025 maximize policy).

## Non-goals (record, don't build)

- user32 GetSystemMenu/WM_SYSCOMMAND emulation for win32 apps — the
  kernel/wm menu serves every window class uniformly; app-side hooks
  only if a port demands them (PORTS.md is empty today).
- A title-bar icon (there are no window icons — stubs by 0068 decision).

## Acceptance

- Headless: EV_SYSMENU round-trip in test_wm_policy.js (chord gated on a
  subscriber, keyup swallowed); e2e — open the menu on a winbox, Move +
  arrows relocates the window, Esc reverts, Size grows a resizable
  window and is disabled on "fixbox"; Close via the menu tears down.
- Browser (`os-wm.mjs` or os-shell leg): Alt+Space opens the menu on the
  focused window; keyboard-only move commits; no WM → the chord reaches
  the app unchanged.
