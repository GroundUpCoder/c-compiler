# 0070 — Desktop as the default tab

- **Status**: open
- **Design**: `todos/OS.md` (the VT/tab bar, todos/done/0022); page state
  in `os/os.html`.

## Goal

Show the **Desktop** (VT2) by default on page load instead of the
Terminal (VT1). The Terminal must stay one click away — the tab bar is
the discoverable switch and the tty remains the escape hatch — but the
first thing the user sees should be the desktop.

## Plan

- The page hardcodes VT1 as the initial tab: `os/os.html` `<body
  data-vt="1">`, `var vt = 1`, `window.__osVt = 1`, and the `active`
  class seeded on `#vt1tab`.
- Don't just flip the constant. VT1 is intentional *during boot*: the
  tty streams the boot log, and `boot-error` calls `setVt(1)` as the
  escape hatch when the desktop stack fails to come up
  (os.html `case 'boot-error'`). Keep that.
- Boot on VT1, then **auto-switch to VT2 once boot completes** — hook
  the existing boot-ready signal (`__osState` transition / first
  successful desktop frame) and call `setVt(2)` there. On `boot-error`
  the existing `setVt(1)` still wins, so a broken desktop still lands
  the user on the tty with the failure visible.
- Leave Ctrl+Alt+F1/F2 and the tab-click handlers untouched.

## Acceptance

- Fresh load with a healthy boot ends on the Desktop tab (`__osVt === 2`),
  with the boot log still having been visible on VT1 during boot.
- A forced boot error still lands on the Terminal tab with the error
  shown (escape hatch preserved).
- One click on the Terminal tab returns to a fully usable tty.
- VT tests updated to the new default: `tests/browser/os-vt.mjs` and any
  initial-VT assertion in `os-boots.mjs` / `os-shell.mjs`. Browser suite
  stays green.
