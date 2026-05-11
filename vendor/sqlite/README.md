# SQLite 3.53.1 (amalgamation)

Source: https://sqlite.org/2026/sqlite-amalgamation-3530100.zip

- **Version**: 3.53.1
- **Author**: D. Richard Hipp and the SQLite team
- **License**: **Public domain**. See https://sqlite.org/copyright.html.
  The famous "blessing" applies in lieu of a typical license:
  *May you do good and not evil. May you find forgiveness for yourself
  and forgive others. May you share freely, never taking more than you
  give.*
- **SHA3-256**: `3c07136e4f6b5dd0c395be86455014039597bc65b6851f7111e88f71b6e06114`

Files in this directory:

- `sqlite3.c` — the amalgamation (~250 KLOC, all of SQLite in one TU)
- `sqlite3.h` — public API header
- `shell.c` — the `sqlite3` CLI REPL
- `sqlite3ext.h` — extension API header (not currently compiled in,
  since `SQLITE_OMIT_LOAD_EXTENSION=1` is set)
- `bin.json` — build config (this project)
- `memory.h`, `utime.h`, `sys/resource.h` — local shim headers (see below)

## Status

**Compiles and links end-to-end; SQL execution fails.** The full
amalgamation (250 KLOC) compiles cleanly to a ~1.4 MB wasm binary
after we added the `IRREDUCIBLE_LOWERING` pass that converts
functions with unstructured control flow into `while(1) switch(state)`
state machines. 136 SQLite functions go through that pass, including
`sqlite3VdbeExec` — the VDBE bytecode interpreter whose ~218
cross-block gotos previously blocked codegen.

The SQLite shell runs and accepts input:

```
$ node host.js /tmp/sqlite.wasm
SQLite version 3.53.1 2026-05-05 10:34:17
Enter ".help" for usage hints.
Connected to a transient in-memory database.
sqlite> .version
SQLite 3.53.1 2026-05-05 10:34:17 c88b22011a54b4f6fbd149e9f8e4de77658ce58143a1af0e3785e4e6475127e9
sqlite> SELECT 1+1;
Parse error near line 1: database disk image is malformed (11)
```

The banner, `.version`, and shell meta-commands work. Any actual SQL
statement (against an in-memory database) reports
"database disk image is malformed (11)" — meaning SQLite's pager
detected corruption in one of its internal page-state checks.

Probable cause: one of the 136 lowered functions has a subtle
semantic difference from the structured original. The lowering pass
is correct in concept (verified by the standalone test
`tests/unit/core/control_flow/goto/irreducible_dispatch`), but
SQLite exercises edge cases — VDBE memory cell tagging, btree page
allocation, pager state machines — that may not survive the
hoist-and-flatten transformation cleanly. Likely suspects:
`sqlite3PagerSharedLock`, `getPageNormal`, `sqlite3BitvecBuiltinTest`,
`sqlite3VdbeMemTranslate`, or `sqlite3VdbeExec` itself.

To debug further: selectively disable lowering for individual
functions to bisect, then inspect the lowered output for the
offending one.

See `todos/MISC.md` for follow-up notes.

## Build (when it works)

```bash
node compiler.js -o /tmp/sqlite.wasm vendor/sqlite/bin.json
node host.js /tmp/sqlite.wasm
```

The expected first-light goal is the `sqlite>` REPL prompt, with
`.help` and `SELECT 1;` working against an in-memory database.

## Build flags

The `bin.json` sets:

| Flag | Purpose |
|---|---|
| `-DSQLITE_WASI` | Umbrella define that gates many POSIX-only paths in sqlite3.c and shell.c (skips `<pwd.h>`, `<sys/mman.h>`, signals, KVM x86 mmap, etc.) |
| `-DSQLITE_THREADSAFE=0` | Single-threaded build. Removes pthread requirements |
| `-DSQLITE_OMIT_LOAD_EXTENSION=1` | No dlopen-style extension loading |
| `-DSQLITE_OMIT_WAL` | No write-ahead log (uses shared memory + mmap) |
| `-DSQLITE_MAX_MMAP_SIZE=0` | Disable memory-mapped I/O (we have no mmap) |
| `-DSQLITE_DEFAULT_MEMSTATUS=0` | Skip per-allocation accounting |
| `-DSQLITE_OMIT_DEPRECATED` | Drop deprecated APIs |
| `-DHAVE_USLEEP=1` | Use `usleep()` (which our libc provides) for backoff |

## Compiler / stdlib gaps closed along the way

Bringing SQLite this far required several real additions to the
compiler and built-in stdlib. These are generic improvements, not
SQLite-specific:

- **Tentative definitions (C11 6.9.2)** — the linker now merges
  multiple `int x;` declarations into one object, and lets `int x = 5;`
  supersede a prior tentative. SQLite uses this pattern for several
  globals.
- **Empty file-scope declaration** — a bare `;` at file scope is now
  silently accepted (C2x standardizes it; GCC/clang accept as an
  extension). SQLite uses macros like `SQLITE_EXTENSION_INIT1` that
  expand to empty and rely on this.
- **Re-declaration of an import as plain `extern`** — when user code
  re-declares a function that was already imported (e.g. shell.c has
  `extern int isatty(int);` after `<unistd.h>` provided
  `__import int isatty(int);`), the parser now preserves the import
  binding instead of shadowing it with the plain-extern node, which
  would otherwise get tree-shaken with no underlying definition.
- **POSIX types** added to `<sys/types.h>`: `pid_t`, `uid_t`, `gid_t`,
  `dev_t`, `ino_t`, `time_t`.
- **`struct stat` extras**: `st_blksize`, `st_uid`, `st_gid`, `st_blocks`.
- **stat-mode test macros**: `S_ISCHR`, `S_ISBLK`, `S_ISFIFO`, `S_ISSOCK`.
- **errno values**: `ENOLCK`, `ETIMEDOUT`.
- **POSIX file ops** in `<unistd.h>`: `ftruncate`, `readlink`, `fsync`,
  `fdatasync`, `sleep`, `symlink`, `chmod`, `realpath`.
- **`fcntl()` + `struct flock` + locking constants** in `<fcntl.h>` —
  `fcntl()` is a no-op that returns 0 (advisory file locking doesn't
  apply in our single-threaded wasm runtime, but SQLite's unix VFS
  needs to *think* it can lock).
- **`utimes()`** in `<sys/time.h>` (no-op stub).

## Local shim headers

These three live in this directory because they're not part of our
built-in stdlib and shell.c includes them unconditionally:

- `memory.h` — legacy header, just redirects to `<string.h>`.
- `utime.h` — declares `struct utimbuf` and a no-op `utime()`. shell.c
  actually uses `utimes()` (with the `s`), not `utime()`; the include
  is essentially dead but has to resolve.
- `sys/resource.h` — declares `struct rusage`, `getrusage()`, and
  `RUSAGE_SELF` / `RUSAGE_CHILDREN`. `getrusage()` is a no-op that
  zeros the buffer, so shell's `.timer` command will always report
  0.000s of CPU time, but the rest works.
