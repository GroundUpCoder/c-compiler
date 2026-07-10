# win32: kernel32 subset over POSIX (todos/0059)

Landed the third veneer slice (after 0057 gdi32, 0058 user32): kernel32 +
advapi32 + the 16-bit wide CRT, implemented strictly to the 0060 demand
log (`os/win32/PORTS.md`). Three new sources in `os/win32/lib.json`:

- **kernel32.c** — last-error, the UTF-16↔UTF-8 boundary
  (MultiByteToWideChar treats CP_ACP as UTF-8: this OS is a UTF-8 world),
  a magic-tagged handle table (file/find/mapping/process kinds + static
  std handles), CreateFile→open (with the CREATE_ALWAYS/OPEN_ALWAYS
  ERROR_ALREADY_EXISTS quirk apps test), FindFirstFile→opendir + a
  case-insensitive wildcard matcher, CreateFileMapping/MapViewOfFile as a
  read-into-heap copy (write-back on unmap for FILE_MAP_WRITE — notepad
  only reads through views), Global/Local/Heap as ONE headered malloc
  (modern Windows puts them on one heap too), VirtualAlloc over
  calloc + a base-table, time (GetTickCount/QPC over clock_gettime,
  GetDateFormatW/GetTimeFormatW as an en-US picture formatter),
  CreateProcess→the owner-brokered `__spawn` spec (Windows cmdline
  tokenizer, PATH search, STARTF_USESTDHANDLES→fd-actions, cwd honored),
  WaitForSingleObject/GetExitCodeProcess over waitpid, module identity
  via the synthetic `/proc/<pid>/cmdline` (0043 paying off), the
  registry-backed profile shim (GetProfileIntW — win.ini maps onto the
  hive like real Windows), FormatMessageW over a small system-message
  table, IsTextUnicode (BOM + zero-odd-byte statistics).
- **advapi32.c** — the registry as a text hive at `$HOME/.win32reg`,
  loaded lazily, written through on mutation (tmp+rename so SIGKILL never
  truncates). Flat key namespace, case-insensitive, values hex-encoded so
  REG_SZ's UTF-16 bytes round-trip exactly. RegDeleteKey/RegEnumKey wait
  for demand.
- **crt16.c** — tchar.h's deviation implemented: `_tcs*` as REAL 16-bit
  symbols (libc wchar_t is 4 bytes, so the msvcrt wide names can't be
  reused), strsafe as real symbols, wsprintfW. One wide formatter
  underneath: parse each %spec, render numerics/floats through libc
  snprintf into a narrow scratch, widen — float formatting never
  reimplemented. `_stscanf` covers calc's exact needs (%I64X/%I64o/%lf)
  plus %s/%c.

## Decisions

- **kernel32 is W-native** — a deliberate deviation from the 0060
  "implemented names are ANSI generics" convention (which stands for
  gdi32/user32, where ANSI demo apps exist). kernel32 arrived with the
  UNICODE-only corpus; there is zero ANSI demand, so the W names are the
  implemented symbols and ANSI generics grow only if an ANSI corpus app
  ever wants one. Recorded in windows.h's kernel32 section note.
- **CreateThread/LoadLibrary fail loudly** (ERROR_CALL_NOT_IMPLEMENTED /
  NULL) per the item's "no silent success" call. calc's uxtheme/htmlhelp
  runtime binding degrades gracefully on NULL exactly as upstream
  intends; notepad's print thread will report failure rather than wedge.
- **Mapping views are copies.** wasm linear memory has no MAP_SHARED
  analog; a read-copy + write-back-on-unmap covers the corpus. Documented
  at the implementation, not hidden.

## Gotchas hit

- `*/` inside a block comment (`_tcs*/_t*`) terminates it — the lexer
  then trips on apostrophes in the prose that follows. Cost one confusing
  "Unexpected character: '\t'" lex error pointing at an innocent line.
- `__fd_action` DUP2 fields: `fd` is the CHILD's target fd, `arg` is the
  source (see posix_spawn_file_actions_adddup2) — I had them swapped and
  the child's stdout redirect silently didn't apply. The k32demo
  redirected-spawn check caught it.

## Acceptance

`/bin/k32demo` (UNICODE build like the corpus, seeded v37): 87
self-checks covering every subsystem, incl. the POSIX-twin identity both
ways (hush cat reads WriteFile's bytes; CreateFileW reads hush's echo)
and a real CreateProcess of `sh -c` writing through a redirected handle
with exit-code round-trip. `tests/kernel/test_kernel32_e2e.js` (wired
into the kernel runner) adds the hush-redirect twin (same bytes, same
exit code) and registry persistence across two boots of one image.

PORTS.md after: winmine 38→29, notepad 118→64, calc 74→45 missing; the
aggregate table is now purely user32-W/menus/dialogs/resources/comdlg32/
shell32/winmm — the natural next slice ("W message pump + resources").

Image v36→v37 (all win32 apps relink with the new lib sources; k32demo
seeded). No kernel.js/host.js/compiler.js changes — the whole slice is
app-side user space, as designed.
