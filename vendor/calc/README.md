# calc — ReactOS Calculator (todos/0060 Win32 port corpus)

Upstream: https://github.com/reactos/reactos `base/applications/calc`
at commit `1a706d759e9ee057408004e22eedc58e2eecca49` (2026-07-09). **GPL-2.0**
per the vendored `copying.txt` (some files carry LGPL headers, e.g. theme.c;
Copyright 1998-2017 Carlo Bramini and contributors).

Files: the IEEE-754 build per upstream CMake — `winmain.c`, `convert.c`,
`fun_ieee.c`, `rpn_ieee.c`, `utl_ieee.c`, `htmlhelp.c`, `theme.c`, `calc.h`,
`resource.h` (compiled; the mpfr variant is not vendored); `resource.rc`,
`CMakeLists.txt`, `copying.txt` for reference (`res/`, `lang/`, help texts not
vendored). Builds UNICODE + `__GNUC__` defined (its own `#ifdef __GNUC__`
arms pick `ULL` literal suffixes; the MSVC arms use `UI64`, which this
compiler doesn't lex).

Status: compile-tested by `tools/win32ports.js` — parses + reaches the link
stage; missing symbols (dialog templates, owner-draw keypad, clipboard,
runtime uxtheme/htmlhelp binding via LoadLibrary/GetProcAddress — note its
dummy_* fallbacks mean stub kernel32 entries returning NULL would suffice)
are logged in `os/win32/PORTS.md`, the 0059+ backlog. Not seeded into the OS
image yet.

## Local patches (keep this table complete)

| where | what | why |
|-------|------|-----|
| winmain.c:1269 | `L"Button"` → `u"Button"` | 4-byte `wchar_t` here; `u""` is the 2-byte WCHAR literal (see os/win32/include/windows.h) |
