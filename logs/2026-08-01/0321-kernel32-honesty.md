# #321 — W1-TD kernel32 honesty batch

Ticket #321: kernel32 accepted-and-dropped flags wholesale behind TRUE
returns — the #317 shape (silent scope cut reported as success) across
files, processes, and mappings. Policy: W0 apply-or-report — apply what
the substrate can express, loud-report (WIN32_UNSUPPORTED) what it
cannot, never silently drop.

## What was applied (real semantics, not reports)

- **CreateFileW dwFlagsAndAttributes** (was `(void)flagsAttrs`):
  - `FILE_ATTRIBUTE_READONLY` on create → chmod 0444 on the file; the
    creating handle keeps its write access (the Windows rule).
  - `FILE_FLAG_DELETE_ON_CLOSE` → path remembered on the handle object,
    unlink at CloseHandle (one handle per CreateFile here, so
    CloseHandle IS the last close).
  - `FILE_FLAG_WRITE_THROUGH` → fsync after each WriteFile.
  - `FILE_FLAG_BACKUP_SEMANTICS` → a read-only directory open really
    opens, via host.js's O_DIRECTORY bit (0x10000, todos/0442 — the
    libc exposes no O_DIRECTORY constant yet, so the raw bit rides in
    kernel32.c as K32_O_DIRECTORY). Without the flag a directory keeps
    the natural EISDIR → ERROR_ACCESS_DENIED refusal, which is also the
    real API's answer.
  - Pure cache hints (NO_BUFFERING/RANDOM_ACCESS/SEQUENTIAL_SCAN/
    TEMPORARY/POSIX_SEMANTICS) and the Windows-default attributes
    (NORMAL/ARCHIVE) stay silently accepted; HIDDEN/SYSTEM, unknown
    bits, FILE_FLAG_OVERLAPPED, and hTemplateFile report loud.
- **ReadFile/WriteFile OVERLAPPED** (was `(void)ov` — positioned IO ran
  at the current file pointer and said TRUE): the Offset pair is
  honored (lseek first), the all-ones pair appends, Internal/
  InternalHigh are filled at return, and a sync-handle OVERLAPPED read
  at EOF answers FALSE + ERROR_HANDLE_EOF (the real API). The
  OVERLAPPED struct is new in windows.h.
- **CreateProcessW lpEnvironment** — the drop was pure laziness: the
  `__spawn_spec` already HAS an envp field. The block (WCHAR under
  CREATE_UNICODE_ENVIRONMENT, else UTF-8, double-NUL terminated) is
  parsed into a one-allocation vector and becomes the child's environ.
- **CreateProcessW hThread** (was NULL → WaitForSingleObject(hThread)
  failed): hThread is the SAME refcounted HK_PROC object as hProcess —
  one thread per process here, thread exit == process exit — so the
  standard wait-either-close-both pattern works. K32Obj grew `refs`;
  CloseHandle decrements before freeing.
- **CreateProcessW CREATE_NEW_PROCESS_GROUP** → `__SPAWN_SETPGID`.
- **CreateFileMappingW section size** (was `(void)sizeHigh/Low`): a
  PAGE_READWRITE section beyond EOF EXTENDS the file at creation (the
  real semantics); a PAGE_READONLY one refuses ERROR_NOT_ENOUGH_MEMORY;
  zero size on an empty file is ERROR_FILE_INVALID. Views are bounded
  by the section (ERROR_INVALID_PARAMETER past it), which kills the old
  silent-grow-with-NULs-at-unmap behavior — the file already spans the
  section before any view exists.

## What reports loud instead (can't be expressed)

- SetFileAttributesW HIDDEN/SYSTEM/ARCHIVE (no POSIX store; READONLY
  half still applied, return stays TRUE — the report is the honesty).
- CreateProcessW CREATE_SUSPENDED (cooperative STOP parks at safe
  points, never at entry; OS.md already earmarks a spec-level suspended
  spawn — that is the real fix, not a veneer hack), unknown creation
  flags, bInheritHandles=FALSE with USESTDHANDLES (contradiction we
  override), hide/minimize wShowWindow values.
- CreateProcessW cmdline >1024 UTF-8 bytes and >63 argv entries now
  REFUSE (ERROR_FILENAME_EXCED_RANGE / ERROR_INVALID_PARAMETER) with a
  report — they used to truncate/drop silently behind TRUE.
- GlobalAlloc GMEM_MOVEABLE (served FIXED: handle==pointer, lock
  uncounted). NB LocalAlloc LMEM_MOVEABLE is the same divergence but
  deliberately SILENT: notepad's text buffer and user32's EDIT allocate
  it on every load/grow and lock before every deref — a report there
  would be a permanent false alarm in every boot. GlobalAlloc carries
  the class's report.
- VirtualAlloc flProtect != PAGE_READWRITE, MEM_RESERVE-without-COMMIT
  (wasm linear memory: no page protection, no reserve tier).

## Gotchas

- The ticket's line coordinates were stale (older tree); every edit was
  anchored by symbol. Two coordinates landed on the WRONG function
  (CreateThread for CreateProcessW, a heap function for VirtualAlloc)
  with near-identical `(void)` cast lists.
- K32Obj's new fields (`delPath`, `wthrough`, `mapSize`, `refs`) grow
  at the TAIL because g_std's positional initializers cover the old
  field count exactly.
- The wide environment-block literal `u"A=1\0B=2\0"` relies on embedded
  NULs in a u"" literal + the implicit terminator making the double-NUL
  — worked first try in our compiler.

Tests: k32demo grew ~30 checks (OVERLAPPED positioned IO + EOF answer,
attribute round-trip, READONLY-on-create, DELETE_ON_CLOSE,
BACKUP_SEMANTICS both ways, section extend/bounds/write-back, waitable
hThread, real lpEnvironment via `sh -c 'echo env=$K32E:$K32UNSET'`,
loud cap refusals, divergence probes); test_kernel32_e2e.js pins the
eight new report lines on stderr. Corpus surveyed before the loud
paths landed: notepad passes FILE_ATTRIBUTE_NORMAL, calc uses
GMEM_DDESHARE (not MOVEABLE), shell32 spawns flags=0/env=NULL and
already closes both PROCESS_INFORMATION handles — the booted estate
stays at zero reports.
