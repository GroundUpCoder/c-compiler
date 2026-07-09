# 0059 — win32: kernel32 subset over POSIX

- **Status**: open
- **Depends**: existing POSIX surface (fds, spawn); grows on demand from 0060
- **Design**: `todos/WIN32.md` (coexistence section)

## Goal

The non-UI Win32 surface ported programs need, as a **user-space veneer**
over the existing POSIX primitives — additive, no kernel change (the
Wine/Cygwin model). POSIX stays the other veneer; a program picks one.

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
