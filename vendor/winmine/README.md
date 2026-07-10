# winmine — ReactOS/Wine Minesweeper (todos/0060 Win32 port corpus)

Upstream: https://github.com/reactos/reactos `base/applications/games/winmine`
at commit `1a706d759e9ee057408004e22eedc58e2eecca49` (2026-07-09). The code is
Wine's winemine (Copyright 2000 Joshua Thielen and contributors), **LGPL-2.1+**
— license header in each source file.

Files: `main.c`, `dialog.c`, `main.h`, `resource.h` (compiled); `rsrc.rc`,
`CMakeLists.txt` kept for reference (resources — bitmaps/menus/dialogs/strings
— are not baked yet; the `rc/` bitmap dir and `lang/` translations are not
vendored). Builds UNICODE, like upstream (`bin.json` defines
`UNICODE`/`_UNICODE`/`__REACTOS__`).

Status: compile-tested by `tools/win32ports.js` against the os/win32 veneer —
parses + reaches the link stage; its missing win32 symbols are logged in
`os/win32/PORTS.md` (the 0059+ implementation backlog). It is NOT seeded into
the OS image yet — that happens when the demand list lands.

## Local patches (keep this table complete)

| where | what | why |
|-------|------|-----|
| main.c:115, main.c:186 | `L"Sound"` → `u"Sound"` | this platform's `wchar_t` is 4 bytes, so `L""` mismatches the 2-byte `WCHAR`; `u""` is the WCHAR-width literal (see os/win32/include/windows.h) |
