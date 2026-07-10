# notepad — ReactOS Notepad (todos/0060 Win32 port corpus)

Upstream: https://github.com/reactos/reactos `base/applications/notepad`
at commit `1a706d759e9ee057408004e22eedc58e2eecca49` (2026-07-09). **GPL-2.0+**
(ReactOS; original authors per file headers — Marcel Baur, Sylvain Petreolle,
Andriy Palamarchuk, Katayama Hirofumi MZ, and others).

Files: `main.c`, `dialog.c`, `printing.c`, `settings.c`, `text.c` + headers
(compiled); `rsrc.rc`, `CMakeLists.txt` kept for reference (menus/dialogs/
accelerators live in resources, not baked yet; `res/`, `lang/` not vendored).
Builds UNICODE, like upstream.

Status: compile-tested by `tools/win32ports.js` — parses + reaches the link
stage; missing symbols (EDIT-around-a-file plumbing, comdlg32 dialogs, menus,
printing) are logged in `os/win32/PORTS.md`, the 0059+ backlog. Not seeded
into the OS image yet.

## Local patches (keep this table complete)

| where | what | why |
|-------|------|-----|
| dialog.c:67, dialog.c:176, text.c:439 | `L"…"` → `u"…"` | 4-byte `wchar_t` here; `u""` is the 2-byte WCHAR literal (see os/win32/include/windows.h) |
