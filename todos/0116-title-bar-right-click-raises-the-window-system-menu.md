# 0116 — Title-bar right-click raises the window system menu

- **Status**: deferred (mass-deferred 2026-07-12; was: open)
- **Design**: `todos/WM.md` ("window system menu" status). Filed by 0102,
  which landed the sysmenu as an Alt+Space / `wmctl sysmenu` chord and
  deferred this pointer affordance.

## Goal

0102 landed the Win95 window system menu (Restore/Move/Size/Minimize/
Maximize/Close, keyboard move/size modes) reachable via **Alt+Space** and
`wmctl sysmenu`, both carrying the focused sid to `ctx_open_sysmenu`. The
plan offered a second trigger — **right-click on the title bar** — as an
option and deferred it to keep 0102 keyboard-only. This item adds it: the
same menu, on the window whose title bar was right-clicked.

## Plan

- The kernel chrome hit-test (`wmPointer`) already classifies the title-bar
  region for drags/close-box. On a right-button (button 3) down in the
  title band, emit the existing **WMP EV_SYSMENU 0x91** with that surface's
  sid instead of starting a drag — subscriber-gated, the EV_CYCLE
  no-subscriber pass-through rule (no WM → the click routes as normal chrome
  input). No new opcode; reuse the 0102 event verbatim.
- wm.c already handles EV_SYSMENU → `ctx_open_sysmenu(find(sid))`; zero
  wm.c change beyond confirming the anchor (0102 anchors at the window's
  top-left; a right-click could anchor at the pointer — decide in-item,
  prefer the pointer for Win95 fidelity if cheap).
- Decide where in `wmPointer`'s chrome branch the right-down is consumed so
  a left-drag stays byte-identical.

## Acceptance

- Headless: a right-button `INJECT_SCREEN` down on a window's title band
  emits EV_SYSMENU { sid } to a subscriber (and nothing with no WM); the
  e2e opens the sysmenu on a winbox via the title right-click, not just
  Alt+Space.
- Browser (`os-wm.mjs` leg): right-clicking a title bar raises the system
  menu on that window.
