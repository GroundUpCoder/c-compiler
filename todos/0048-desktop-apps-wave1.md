# 0048 — desktop apps wave 1

- **Status**: open
- **Depends**: 0047 (the toolkit)
- **Design**: discussion in `logs/2026-07-09/roadmap-network-desktop.md`

## Goal

The Win95 organ set as `/bin` apps + Start-menu entries: **file
manager, notepad, calc, minesweeper, control panel**. Land
incrementally — each app is its own commit with its own acceptance.

## Plan

- **fileman**: directory listing over plain POSIX calls; double-click:
  directories navigate, executables spawn (an `/etc/openwith` map is a
  later idea, not v1).
- **notepad**: open/edit/save text. microui's textbox is single-line —
  budget a small multi-line edit widget here (or this is where the
  nuklear trade-up decision gets made; see 0047).
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
