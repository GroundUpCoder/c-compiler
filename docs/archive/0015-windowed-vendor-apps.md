# 0015 — windowed vendor apps in-OS: doom, snake, gameboy

- **Status**: done (2026-07-07 — `logs/2026-07-07/windowed-vendor-apps.md`)
- **Depends**: 0013 (WM v1 — hard); 0014 (soft — wmctl/taskbar make the
  acceptance test nicer, not required)
- **Design**: `todos/WM.md` (implementation plan unit 7 — this is the
  design's own acceptance test); vendor `bin.json`s

## Goal

The WM design's acceptance test: existing SDL vendor apps run windowed
in-OS with **zero source changes**. Quake is split to `todos/0018` (needs
the relative-mouse/pointer-lock surface flag, which did not land in v1).

- **Binary-asset seeding**: a new image.json entry type for repo-relative
  binary files, so `doom1.wad` (~4MB) and the gameboy ROMs land in BlockFS
  at seed time — `os-common.js` knows only `c`/`text`/`project`/`link`
  today. Bump `image.json` version.
- Seed `/bin/doom`, `/bin/snake`, `/bin/gameboy` via the existing
  `project` entry path (busybox precedent); WAD at a path `d_iwad.c`
  searches; ROMs under `/root/roms` (gameboy takes the ROM as argv).
- Audio stays gracefully absent until 0017 (`dg_sound.c` already
  NULL-checks the failed stream open).

## Acceptance

- `doom &` from hush opens a playable window in the browser — keyboard
  input works, close box quits cleanly; snake and gameboy likewise
  (gameboy with a ROM argument).
- Headless: kernel screenshot of a running doom frame is verifiably a real
  frame (shm transport is bit-exact; goldens only if deterministic).
- Browser acceptance test (extend `tests/browser/os-wm.mjs` or a new
  `os-doom.mjs`), manual like the others; all existing suites stay green.
