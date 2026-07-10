# 0096 — Screensaver — idle-triggered, Win95 classics

- **Status**: open
- **Design**: `todos/WM.md` (the desktop/Start menu already use fullscreen
  borderless top-layer surfaces — the same pattern a screensaver wants); an
  idle timer in `os/wm.c`. Optional Screen Saver tab in Control Panel v2
  (0089).

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
