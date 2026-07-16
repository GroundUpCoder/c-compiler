# notepad — ReactOS Notepad (todos/0060 Win32 port corpus)

Upstream: https://github.com/reactos/reactos `base/applications/notepad`
at commit `1a706d759e9ee057408004e22eedc58e2eecca49` (2026-07-09). **GPL-2.0+**
(ReactOS; original authors per file headers — Marcel Baur, Sylvain Petreolle,
Andriy Palamarchuk, Katayama Hirofumi MZ, and others).

Files: `main.c`, `dialog.c`, `printing.c`, `settings.c`, `text.c` + headers
(compiled); `rsrc.rc` + `lang/en-US.rc` (resources — compiled by
`tools/win32rc.js` into the committed sidecar pack `notepad.res`, seeded
next to the binary as `/bin/notepad.res`; regenerate after touching the rc
sources with
`node tools/win32rc.js vendor/notepad/rsrc.rc -o vendor/notepad/notepad.res -D LANGUAGE_EN_US -D __REACTOS__`);
`CMakeLists.txt` kept for reference (`res/`, non-English `lang/` not
vendored — the notepad.ico stays a stub handle). Builds UNICODE, like
upstream; the `_tWinMain` entry rides `os/win32/wwinmain.c` in bin.json.

Status: fully linked against the veneer since todos/0048 (EDIT-around-a-file
via EM_GETHANDLE/EM_SETHANDLE, comdlg32 file dialogs + find/replace, the
comctl32 status bar, the clipboard) and seeded into the OS image as
`/bin/notepad` — usable, with a Start menu entry. Printing stays an honest
cancel (PrintDlgW/PageSetupDlgW return FALSE **with a loud
`win32: unsupported` report** since the 0222 menu audit; the StartDoc family
fails loud), ChooseFontW cancels loudly the same way (a real font dialog is
todos/0223), and the Save As encoding combo degrades to the current value
(OFN hooks/templates not run — grow on demand). `tools/win32ports.js` keeps compile-testing it (`expect: links`);
`tests/kernel/test_notepad_e2e.js` is the acceptance test.

## Local patches (keep this table complete)

| where | what | why |
|-------|------|-----|
| dialog.c:67, dialog.c:176, text.c:439 | `L"…"` → `u"…"` | 4-byte `wchar_t` here; `u""` is the 2-byte WCHAR literal (see os/win32/include/windows.h) |
