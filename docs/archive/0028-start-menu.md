# 0028 — start menu: Start button + /etc/menu launcher

- **Status**: done (2026-07-08; dev log `logs/2026-07-08/start-menu.md`)
- **Depends**: — (0029's desktop layer completes dismiss-on-desktop-click;
  not blocking)
- **Design**: `todos/WM.md` "The desktop shell" (start-menu block + the
  verified substrate facts: multi-window wm.c via `windowID`, borderless
  click mechanics, spawn/readdir availability)

## Goal

A Win95 Start button at the taskbar's left; clicking it pops a borderless
menu surface listing **/etc/menu** entries; selecting one spawns it. All
wm.c policy — zero kernel changes.

## Plan

- wm.c: reserve ~50px at the taskbar's left for the Start button (window
  buttons shift right); second SDL window for the menu, created on click,
  destroyed on selection/dismiss; per-event dispatch by
  `e.button.windowID` (events already carry it).
- Entries from `readdir("/etc/menu")`, plain sort, name = filename:
  symlink → exec its target; one-line text file → argv line (tty apps
  ride `term ...`). Render with the 5×7 font.
- Spawn: `posix_spawn`, PATH=/bin, cwd=/root (doom's WAD is cwd-relative).
  **Resolve in-item**: child stdio for service-spawned apps (no fd 0/1/2
  today — verify harmless or open /dev/null-ish fds via file actions).
- Dismiss: menu click outside an entry, EV_FOCUS change, taskbar click.
- Seed `/etc/menu` in image.json (doom, quake, gameboy, term, winbox,
  gpubox; `term snake` as the text-entry example); bump image version.

## Acceptance

- `test_wm_service_e2e.js` legs (real /bin/wm over boot.js): Start click
  → menu surface appears in `wmctl list`; entry click → the app's window
  appears (winbox — cheap) and the menu is gone; focus-change dismisses.
- Browser (`os-wm.mjs` leg or a new `os-shell.mjs`): click Start, menu
  pixels present, launch winbox from it, window composites.
