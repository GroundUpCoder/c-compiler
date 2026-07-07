# 0022 — VT switching: tty ↔ desktop

- **Status**: open
- **Depends**: — (pure UI-bridge work; the full-viewport-desktop
  follow-on needs dynamic screen resolution, deliberately out of scope)
- **Design**: `todos/WM.md` ("Screen, VTs, and scaling fixed-size
  clients")

## Goal

Linux-console semantics for os.html: the xterm tty is VT1, the desktop
is VT2; the page shows exactly one at a time, with a keybinding and a
visible affordance to switch. Rationale: **availability under partial
failure** — VT1's path is kernel worker + xterm only (no compositor, no
wm, no GPU), so the shell stays fully usable when the desktop is broken
or merely suspect; a maintenance mode, not a layout preference. The
everyday terminal still becomes a window via 0020 — VT1 remains the
escape hatch / bootstrap chrome after that.

## Plan

- os.html only (the page is already a dumb bridge): show one of
  `#terminal` / `#desktop`; toggle keybinding (pick one the browser
  won't eat — bare Ctrl+Alt+F1 is OS-contested) plus a switch control
  in `#status`; xterm re-fit on VT1 entry, canvas focus on VT2 entry.
- Kernel/compositor: NO changes — keep compositing while hidden
  (mailbox frames, bounded cost). Pointer lock drops on switch
  (browser-enforced) and re-arms per 0018 on the next client click.
- boot.js: unaffected (headless has no desktop).
- Out of scope: sizing the desktop to the full viewport on VT2 — that
  needs dynamic screen resolution (WM.md section); this item keeps the
  800×500 canvas.

## Acceptance

- Browser: boot lands on VT1, tty full-page; switch → desktop
  interactive; switch back mid-app (doom running) → tty works, desktop
  intact on return.
- Kill the wm service (or wedge a windowed app): VT1 still switches and
  the shell works — the failure-mode rationale, demonstrated.
- A `tests/browser/` leg exercising the toggle; existing suites green.
