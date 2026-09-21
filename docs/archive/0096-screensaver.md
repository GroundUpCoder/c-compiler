# 0096 — Screensaver — idle-triggered, Win95 classics

- **Status**: done (2026-07-11) — landed in full: kernel idle clock (WMP
  GET_IDLE/R_IDLE, `_wmLastInput` stamped at wmKey/wmPointer) + SAVER
  gesture → EV_SAVER (`wmctl idle`/`wmctl saver`); wm.c policy — 1s config
  poll (os/saver.h store: ~/.config/screensaver → /etc → baked /usr/share,
  keys saver/timeout/text, default starfield/900s), fullscreen borderless
  top-layer focus-keeping "screensaver" window raised past the timeout,
  ANY input on it dismisses + restores focus; marquee + starfield draw
  routines; ctlpanel Screen Saver applet (radios/Apply carry-forward
  writes, Preview = WMP SAVER); image v57. Verified:
  tests/kernel/test_saver_e2e.js (25 checks) + test_wm.js mechanism legs
  + tests/browser/os-saver.mjs, full kernel suite green. Follow-ups:
  Mystify/3D-pipes savers → todos/0115; the operator look-and-feel check
  joined the 0064 sweep list. Recorded trims: EV_SCREEN dismisses (idle
  re-raises) rather than re-fitting; hidden-tab vsync parking pauses the
  animation (0100 semantics); VT1 tty typing is not wm input, so it does
  not feed the idle clock (the saver lives on VT2 where that is moot).
- **Design**: `todos/WM.md` "Implementation status — screensaver" (the
  landed record); originally: the desktop/Start menu fullscreen
  borderless top-layer pattern + an idle timer in `os/wm.c`, optional
  Screen Saver tab in Control Panel v2 (0089).

## Goal

Iconic, self-contained, and genuinely fun: after an idle interval, cover the
screen with a classic saver (starfield / Mystify / 3D-pipes) or the "Windows
95" scrolling-marquee text, dismissed on input. Nothing owns it, nothing
rules it out, and it has no dependencies.

## Plan

- **Idle detection** — `os/wm.c` tracks last input (pointer/key) time; after
  the configured timeout with no input, launch the active saver.
- **Saver surface** — a fullscreen borderless top-layer surface (reuse the
  desktop-layer mechanism), black background, the animation drawn per frame;
  any pointer move or key destroys it and restores focus.
- **Savers** — start with the **marquee** (scrolling text banner — trivial,
  instantly recognizable) and a **starfield**; Mystify / pipes as follow-ups.
  Each saver is a small self-contained draw routine picked by name.
- **Config** — timeout + chosen saver in a settings file
  (`/etc/screensaver` or `~/.config/screensaver`); a Screen Saver applet tab
  in Control Panel (0089) to pick saver + timeout + preview.

## Non-goals (record, don't build)

- Password-on-resume / lock screen — the OS is single-user (OS.md), no lock.
- `.scr` as a pluggable third-party format — savers are built-in routines.
- GPU/3D savers beyond simple 2D — keep the composite cost low.

## Acceptance

- Headless: with a short test timeout, no input for the interval raises the
  saver surface (assert it exists on the top layer); an injected pointer move
  removes it and restores the prior focus.
- Browser (`os-shell.mjs`): idle for the timeout shows the marquee/starfield
  animating fullscreen; moving the mouse dismisses it back to the desktop.
