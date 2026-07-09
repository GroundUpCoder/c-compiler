# 0048 — desktop apps wave 1

- **Status**: **reframed** (2026-07-09) — the Win95 organ set now arrives
  as real ReactOS C/Win32 ports via `0060`, not hand-written microui/MVU
  apps. See `WIN32.md`. The app *targets* below stand; the *how* is Win32
  ports.
- **Design**: `WIN32.md`; original discussion in
  `logs/2026-07-09/roadmap-network-desktop.md`

## Goal

The Win95 organ set as `/bin` apps + Start-menu entries: **file
manager, notepad, calc, minesweeper, control panel**. Land
incrementally — each app is its own commit with its own acceptance. Rides 0058
(user32) and 0060 (the port harness + its first-wave targets).

## Plan

- **fileman**: directory listing over plain POSIX calls; double-click:
  directories navigate, executables spawn (an `/etc/openwith` map is a
  later idea, not v1).
- **notepad**: the ReactOS notepad (`0060`) — a real `EDIT`-control app;
  the multi-line editor is user32's `EDIT` (`0058`), not a bespoke
  widget. Retires the old MVU-editor dependency entirely.
- **calc**: Win95-style button grid.
- **minesweeper**: the identity piece. Core logic as plain C,
  unit-testable without the GUI.
- **control panel**: screen info, wallpaper picker (0049), volume —
  volume needs a small kernel addition: master (or per-source) gain on
  the 0017 mixer (an AUDIO_* opcode + the slider). Scope the gain op
  here.
- Start-menu entries via the seeded menu dir; image version bump per
  landing.

## Acceptance

- Each app launches from the Start menu and is drivable headless via
  `wmctl` injection for at least one scripted interaction.
- Minesweeper core (reveal/flood/win/lose) passes as a compiled
  non-GUI test.
- Existing browser pixel tests stay green (new Start-menu entries must
  not break the os-shell.mjs asserts).
