# 0059 — win32: kernel32 subset over POSIX

- **Status**: done (2026-07-10) — `os/win32/kernel32.c` (handles/files/find/
  mapping/memory/time/CreateProcess-over-__spawn/NLS/UTF-16 boundary) +
  `advapi32.c` (file-backed hive at `$HOME/.win32reg`) + `crt16.c` (the
  16-bit wide CRT: `_tcs*`, strsafe, `wsprintfW`). kernel32 is W-native
  (no ANSI generics — the demanding corpus is UNICODE-only; documented in
  windows.h). Acceptance: `/bin/k32demo` (UNICODE build, 87 self-checks
  incl. both POSIX-twin directions and a real spawn through a redirected
  std handle) + `tests/kernel/test_kernel32_e2e.js` (adds registry
  persistence across boots). PORTS.md tail: winmine 38→29, notepad
  118→64, calc 74→45 — every kernel32/advapi32/CRT symbol cleared; the
  remainder is user32-W/menus/dialogs/comdlg32/shell32/winmm. Image v37.
  Dev log: `logs/2026-07-10/win32-kernel32.md`.
- **Design**: `todos/WIN32.md` (coexistence section)

## Goal

The non-UI Win32 surface ported programs need, as a **user-space veneer**
over the existing POSIX primitives — additive, no kernel change (the
Wine/Cygwin model). POSIX stays the other veneer; a program picks one. Sits on the
existing POSIX surface (fds, spawn); the surface grows on demand from
0060's missing-symbol backlog.

## Plan

- **Handle table**: `HANDLE` ↔ fd/object; `CloseHandle`.
- **Files**: `CreateFile`/`ReadFile`/`WriteFile`/`SetFilePointer`/
  `GetFileSize`/`FlushFileBuffers` → `open`/`read`/`write`/`lseek`/`fstat`;
  `FindFirstFile`/`FindNextFile` → `opendir`/`readdir` + wildcard;
  `Get`/`SetFileAttributes`, `CreateDirectory`, `DeleteFile`, `MoveFile`.
- **Memory**: `VirtualAlloc`/`VirtualFree` → `mmap`; `HeapAlloc`/`HeapFree`
  → `malloc`.
- **Time**: `GetSystemTime`/`GetTickCount`/`QueryPerformanceCounter` →
  `clock_gettime`.
- **Process**: `CreateProcess` → `posix_spawn` (`STARTUPINFO`, handle
  inheritance); `GetModuleHandle`/`GetCommandLine` (static-link stubs).
- **Strings**: the UTF-16↔UTF-8 boundary; `MultiByteToWideChar`/
  `WideCharToMultiByte`; the A/W dual-entry convention (implement W, shim
  A) — decide once, apply everywhere.
- **Registry (`advapi32`)**: a small file-backed hive (`RegOpenKey`/
  `RegQueryValue`/`RegSetValue`) so settings-reading apps run.
- **OUT for now**: threads/sync (0006 dropped — single-threaded apps
  only), `OVERLAPPED`/IOCP, COM. Stub with clear `ERROR_CALL_NOT_IMPLEMENTED`
  failures rather than silent success.

## Acceptance

- A file-IO + spawn console sample behaves identically to its POSIX twin.
- The missing-symbol log from 0060 has a shrinking tail.
