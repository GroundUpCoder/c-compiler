# winmine — ReactOS/Wine Minesweeper (todos/0060 Win32 port corpus)

Upstream: https://github.com/reactos/reactos `base/applications/games/winmine`
at commit `1a706d759e9ee057408004e22eedc58e2eecca49` (2026-07-09). The code is
Wine's winemine (Copyright 2000 Joshua Thielen and contributors), **LGPL-2.1+**
— license header in each source file.

Files: `main.c`, `dialog.c`, `main.h`, `resource.h` (compiled); `rsrc.rc` +
`lang/en-US.rc` + `rc/{faces,leds,mines}.bmp` (resources — compiled by
`tools/win32rc.js` into the committed sidecar pack `winmine.res`, seeded
next to the binary as `/bin/winmine.res`; regenerate after touching the rc
sources with
`node tools/win32rc.js vendor/winmine/rsrc.rc -o vendor/winmine/winmine.res -D LANGUAGE_EN_US -D __REACTOS__`).
The `rc/winemine.ico` icon, the `.wav` sound effects, and the non-English
`lang/` translations are deliberately not vendored — LoadIcon/LoadImage
return stub handles, and PlaySound (real since todos/0094) keeps
SND_RESOURCE as silent success: winmine's per-second timer tick must not
fall back to the default ding.
`CMakeLists.txt` kept for reference. Builds UNICODE, like upstream
(`bin.json` defines `UNICODE`/`_UNICODE`/`__REACTOS__`).

Status: fully linked against the veneer since todos/0068 (the user32/
resource tail) and seeded into the OS image as `/bin/winmine` — playable.
`tools/win32ports.js` keeps compile-testing it (`expect: links`).

## Local patches (keep this table complete)

| where | what | why |
|-------|------|-----|
| main.c:115, main.c:186 | `L"Sound"` → `u"Sound"` | this platform's `wchar_t` is 4 bytes, so `L""` mismatches the 2-byte `WCHAR`; `u""` is the WCHAR-width literal (see os/win32/include/windows.h) |
