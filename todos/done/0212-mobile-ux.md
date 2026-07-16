# 0212 — Mobile UX: long-press->right-click + VT1 font toggle/key strip

- **Status**: done (2026-07-16)
- **Design**: logs/2026-07-16/mobile-ux.md

## Goal

Make gucOS usable from a touch device with ZERO kernel/WM/C change:

1. A page-side touch layer on the desktop canvas (os.html) that
   synthesizes the SAME wm-input records the mouse handlers send —
   tap = click (double-tap = the kernel double-click), move-past-slop =
   drag with a deferred down at the original point, 500ms long-press =
   right down+up (context menus everywhere the WM already offers them),
   two-finger vertical pan = wheel.
2. VT1 mobile affordances: A−/A+ font-size steps in the tab bar
   (live refit, localStorage persistence, larger narrow-viewport
   default) and a soft-keyboard key strip (Esc, Tab, sticky Ctrl,
   arrows, | ~ / -) feeding the ordinary tty input path.

## Outcome

Both landed page-side only, one commit each, plus browser tests
(`tests/browser/os-touch.mjs` driving CDP touch emulation,
`tests/browser/os-vt1mobile.mjs` proving every strip key by effect).
Gates: image v99, kernel 73/73, sweep 27/27, both new files stable under
the `--repeat 3 --under-load` flake gate. Notable find: a wheel event
needs a preceding hover MOVE (SDL fills the wheel's mouse position from
the last motion), so the touch layer synthesizes one per pan step.
Details + screenshots: logs/2026-07-16/mobile-ux.md.

## Acceptance

- Long-press raises the desktop/icon/taskbar-button menus; tap
  dismisses/activates; double-tap launches; touch title-drag moves a
  window by the exact delta; two-finger pan scrolls notepad's EDIT. ✅
- Mouse-desktop behavior unchanged (os-wm/os-ctxmenu/os-vt green). ✅
- VT1 font steps refit + persist; the strip's keys act in the booted
  OS (hush completion, history, vi mode switch, ^U/^D). ✅
