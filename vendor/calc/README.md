# calc — ReactOS Calculator (todos/0060 Win32 port corpus)

Upstream: https://github.com/reactos/reactos `base/applications/calc`
at commit `1a706d759e9ee057408004e22eedc58e2eecca49` (2026-07-09). **GPL-2.0**
per the vendored `copying.txt` (some files carry LGPL headers, e.g. theme.c;
Copyright 1998-2017 Carlo Bramini and contributors).

Files: the IEEE-754 build per upstream CMake — `winmain.c`, `convert.c`,
`fun_ieee.c`, `rpn_ieee.c`, `utl_ieee.c`, `htmlhelp.c`, `theme.c`, `calc.h`,
`resource.h` (compiled; the mpfr variant is not vendored); `resource.rc` +
`lang/en-US.rc` (resources — compiled by `tools/win32rc.js` into the
committed sidecar pack `calc.res`, seeded next to the binary as
`/bin/calc.res`; regenerate after touching the rc sources with
`node tools/win32rc.js vendor/calc/resource.rc -o vendor/calc/calc.res -D LANGUAGE_EN_US -D __REACTOS__`);
`CMakeLists.txt`, `copying.txt` for reference (`res/`, help texts, non-English
`lang/` not vendored — the calc.ico stays a stub handle). Builds UNICODE +
`__GNUC__` defined (its own `#ifdef __GNUC__` arms pick `ULL` literal
suffixes; the MSVC arms use `UI64`, which this compiler doesn't lex); the
`_tWinMain` entry rides `os/win32/wwinmain.c` in bin.json.

Status: fully linked against the veneer since todos/0048 (clipboard,
keyboard translation, owner-draw keypad, TrackPopupMenu, WRES v2 template
menus) and seeded into the OS image as `/bin/calc` — usable, with a Start
menu entry. `tools/win32ports.js` keeps compile-testing it
(`expect: links`); `tests/kernel/test_calc_e2e.js` is the acceptance test.
Its uxtheme/htmlhelp runtime binding still degrades by design: LoadLibrary
fails loudly (0059) and calc's own dummy_* fallbacks take over.

## Local patches (keep this table complete)

| where | what | why |
|-------|------|-----|
| winmain.c:1269 | `L"Button"` → `u"Button"` | 4-byte `wchar_t` here; `u""` is the 2-byte WCHAR literal (see os/win32/include/windows.h) |
