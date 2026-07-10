# 0068 — win32: user32/resource tail — winmine playable

- **Status**: done (2026-07-10) — winmine links (0 missing), seeded as
  `/bin/winmine` + `/bin/winmine.res` (image v38), playable headless and
  in-browser; notepad 64→27, calc 45→15. Resources = the sidecar-pack
  story (`tools/win32rc.js` → WRES `<binary>.res`); menus/dialogs/
  accelerators/timers/W-entries in user32.c; `SDL_SetWindowSize` →
  kernel `SURFACE_RESIZE` (0x1007) is the one kernel change. Log:
  `logs/2026-07-10/win32-winmine.md`; acceptance
  `tests/kernel/test_winmine_e2e.js` + `tests/browser/os-winmine.mjs`.
- **Design**: `todos/WIN32.md`; demand log `os/win32/PORTS.md`

## Goal

Close the gap 0057/0058/0060 deliberately left open on the UI side: the
vendored ReactOS apps compile and reach the link stage, but the
user32/gdi32/resource half of their missing-symbol log has no owner —
0059 covers only the kernel32/advapi32 (non-UI) surface. This item owns
that residue, with **winmine seeded and playable** as the concrete
acceptance bar. (Slotted best after 0059 so the A/W string boundary and
registry it establishes are available.)

## Plan

Work from `os/win32/PORTS.md` (regenerate with `node tools/win32ports.js`
as 0059 lands — the tail below shrinks); the stable categories:

- **W entry points** for the implemented ANSI user32/gdi32 surface
  (RegisterClassExW, CreateWindowExW, DefWindowProcW, GetMessageW,
  DispatchMessageW, SendMessageW, wsprintfW, lstr*W, ...) — apply the
  A/W dual-entry convention from 0059/windows.h once, everywhere.
- **Resources**: winmine needs string/bitmap/icon/cursor/accelerator/menu
  tables from its .rc — decide the story (tiny rc compiler vs. hand-baked
  resource blobs vs. compiled-in tables) and implement LoadStringW,
  LoadBitmapW, LoadImageW, LoadCursorW, LoadIconW, LoadAcceleratorsW.
- **Dialogs from resource templates**: DialogBoxParamW, EndDialog,
  Get/SetDlgItemInt, Get/SetDlgItemTextW (deferred out of 0058).
- **Menus + accelerators**: GetMenu, CheckMenuItem,
  TranslateAcceleratorW.
- **Windowing utils**: AdjustWindowRect, GetSystemMetrics,
  GetMonitorInfoW, MonitorFromRect, RedrawWindow, SetTimer.
- **Odds and ends**: ShellAboutW (shell32), PlaySoundW (winmm — a stub
  that returns success is acceptable v1), ExitProcess if 0059 didn't
  take it.

Notepad/calc want the same categories (their tails shrink for free);
finishing THEIR remaining symbols to zero is not in scope here.

## Acceptance

- `node tools/win32ports.js --check` shows winmine at **zero missing
  symbols**; the report is regenerated and committed.
- winmine is seeded into the OS image (image version bump) and playable:
  launches, a scripted `wmctl` interaction can reveal a cell, and the
  game repaints correctly.
- notepad/calc missing-symbol counts strictly decrease (report proves it).
