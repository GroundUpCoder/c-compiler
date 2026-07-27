# MicroPython 1.28.0 — the gucOS port

- **Version**: v1.28.0 (`genhdr/mpversion.h`)
- **Upstream**: https://github.com/micropython/micropython
- **License**: MIT (see `LICENSE`)
- **Shipped as**: the `micropython` gucman package (`packages/micropython.json`)
  → `/usr/local/bin/micropython` and `/usr/local/bin/python`

Built by `bin.json` (the hand-listed-sources convention this repo uses for
every vendored project — there is no configure/Makefile runner here). A second
manifest, `test_bin.json`, builds the SAME sources under a second name so
`tests/run.py`'s `micropython` / `micropython-upstream` categories can point at
their own artifact; both link `main.c`, so the corpus exercises the shipped
binary's real code path.

## Config choice

`mpconfigport.h` starts from `MICROPY_CONFIG_ROM_LEVEL_MINIMUM` and enables
features explicitly on top. It is **not** upstream's unix-port config: the unix
port is built on `MICROPY_VFS` + `MICROPY_VFS_POSIX` (a mount table inside
MicroPython), and gucOS already owns mounting in the kernel (`todos/KERNEL.md`)
— a second one underneath it would be two filesystems disagreeing about the
same paths. So the port takes the unix port's *file object* and leaves its VFS
behind (see `file.c` below).

The feature set is the `todos/0117` **Round 2** target: a real script runner
with file I/O (R1) plus a curated stdlib and a real search path (R2).

### The module set, and why these

R1's config was `MICROPY_CONFIG_ROM_LEVEL_MINIMUM` plus explicit opt-ins, and
the opt-ins were all language features. The consequence was easy to miss and
worth stating plainly: **the built-in module set was `math`, `io`, `sys`,
`builtins` and nothing else** — not `struct`, not `collections`, not even
`gc`, although `py/modstruct.c` and friends were already listed in `bin.json`
and compiling to empty translation units. R2 curates deliberately:

| Module | Where it comes from | Why |
| --- | --- | --- |
| `array` `collections` `struct` `errno` `gc` `micropython` `cmath` | already in `py/`, needed only a `#define` | zero cost; `struct`/`collections` are load-bearing for anything that parses or models data |
| `os` (+ `os.path`) | `extmod/modos.c` + `portmodos.c` | a script that cannot list a directory or join a path is not a script runner |
| `json` | `extmod/modjson.c` | the single most common "why is this a footgun" answer; no dependencies |
| `time` | `extmod/modtime.c` + `shared/timeutils/` + `portmodtime.c` | needs the HAL clock, which was a `return 0` stub before R2 |
| `re` | `extmod/modre.c` + `lib/re1.5/` | one self-contained vendored regex engine, `#include`d into modre.c |
| `random` | `extmod/modrandom.c` | self-contained; seeded from `mp_hal_time_ns()` |
| `binascii` | `extmod/modbinascii.c` | base64/hex, no dependencies (`crc32` needs `MICROPY_PY_DEFLATE`, so it is absent) |
| `heapq` `platform` | `extmod/modheapq.c`, `extmod/modplatform.c` | a few hundred lines each, no dependencies |

`sys.modules` is on (`MICROPY_PY_SYS_MODULES`): without the import cache every
`import foo` re-executes `foo.py`, so two modules importing a third get two
copies of its state. That is a correctness bug the moment a program has more
than one file, which is exactly what R2 makes possible.

### `sys.path`

Four entries, built in `main.c` (which carries the full rationale):

    [<script's directory> | ""] , ".frozen" , /usr/local/lib/micropython , <dir of the real binary>/lib

* Entry 0 is the **script's** directory (CPython's rule), or `""` (cwd) for
  `-c` / `-m` / stdin / the REPL. R1 left it as `""` always, so a two-file
  program only worked when you happened to run it from its own directory.
* The writable site dir is under **`/usr/local`**, not `/usr/lib`: `/usr` is a
  sealed read-only volume (`todos/0040`), so a site dir there could never be
  written to. `/usr/local` is the admin's writable territory — the same reason
  `PATH` is `/usr/local/bin:/bin`.
* It comes **before** the package's own `lib`. CPython orders stdlib before
  site-packages, so this deliberately diverges; it agrees instead with every
  other layered lookup in gucOS (PATH, `/etc/menu` over `/usr/share/menu`, the
  `os/cfgstore.h` overlay), where the writable layer wins.
* The package `lib` dir is **derived from the binary's location** by chasing
  argv[0]'s trailing symlinks, not hardcoded. micropython is a gucman package:
  `/opt/micropython` when installed, `/usr/opt/micropython` on a
  `--packages=all` bake, reached through a `/usr/local/bin` or `/usr/bin`
  symlink either way. (Same trick, same reason, as `user32.c`'s `res_chase`.)

Entries are added even when the directory does not exist. A missed stat per
top-level import is nothing, and `python -c 'import sys; print(sys.path)'` is
how a user finds out where to put a module — a path that omits the answer is
worse than one with a dead entry in it.

### Regenerating `genhdr/`

`genhdr/qstrdefs.generated.h`, `moduledefs.h`, `root_pointers.h` and
`compressed.data.h` are GENERATED from the sources + `mpconfigport.h`. Upstream
regenerates them on every build; this repo commits them. **After any
`mpconfigport.h` change, or any source change that adds an `MP_QSTR_*` /
`MP_REGISTER_MODULE` / `MP_REGISTER_ROOT_POINTER`, run:**

```
node tools/mkmpgenhdr.js
```

That tool drives upstream's own generator scripts (`py/makeqstrdefs.py`,
`py/makeqstrdata.py`, `py/makemoduledefs.py`, `py/make_root_pointers.py`,
`py/makecompresseddata.py`) over a `cc -E` pass, mirroring `py/mkrules.mk`. Its
`--check` mode is a test (`micropython/genhdr-sync` in `tests/run.py`), so a
forgotten regeneration is caught rather than surfacing as a link error.

Before `todos/0117` R1 these headers were hand-extended, which is why
`mpconfigport.h` carried a "only enable features that don't need QSTR pool
regeneration" ceiling. That ceiling is gone.

## Patch table

Everything under `py/`, `shared/` and `extmod/` is upstream-verbatim except
where noted. Port-local files (upstream's ports/ layer) are ours.

| File | Origin | Change |
| --- | --- | --- |
| `main.c` | upstream `ports/minimal/main.c` | Rewritten into the gucOS CLI driver (`todos/0117` R1): argv grammar (`script args…`, `-c cmd`, `-`, `-h`, `-V`), `sys.argv`, exit statuses (`sys.exit`, uncaught exception → 1, usage → 2), tracebacks to `MICROPY_ERROR_PRINTER`, stdin-as-script when stdin is not a tty, `mp_import_stat` over POSIX `stat`, `mp_stderr_print`, `__minstack(1048576)`. The `gc_dump_info()` call inside `gc_collect()` is dropped (it printed GC stats into program output on every collection). The dead `MICROPY_MIN_USE_CORTEX_CPU` / `MICROPY_MIN_USE_STM32_MCU` blocks are kept verbatim. `do_*` shapes follow `ports/unix/main.c`. **R2** added the `sys.path` policy (`setup_sys_path`/`sys_path_set_script_dir`/`exe_dir`/`chase_links`), `-m` (`do_module`, over `MICROPY_MODULE_OVERRIDE_MAIN_IMPORT` — upstream's own mechanism), and split `report_uncaught` out of `execute_lexer` so `-m` reports failures identically. |
| `file.c` | upstream `extmod/vfs_posix_file.c` | Port-local derivative. The VFS gate (`MICROPY_VFS_POSIX`) becomes `MICROPY_PY_BUILTINS_OPEN`; the `extmod/vfs_posix.h` include is dropped; the `vfs_` prefix is dropped from the C symbols; the win32/macOS `fsync` special cases, the `MICROPY_PY_OS_DUPTERM` write shortcut and the `MICROPY_PY_SELECT` poll branch are removed (one target, none of those configs). `mp_builtin_open` — which upstream gets from `extmod/vfs.c`'s `mp_vfs_open` — is added at the bottom with the same `(file, mode, buffering, encoding)` signature. **The file struct's tag is `_mp_dummy_t` on purpose**: `py/modsys.c` and `py/modbuiltins.c` reach the `sys.std*` objects through `extern struct _mp_dummy_t` ("type is irrelevant, just need pointer"), and compiler.js's linker — unlike a C linker — rejects a cross-TU type conflict. |
| `mphalport.h` | port-local | Added `MP_HAL_RETRY_SYSCALL`, verbatim from upstream `ports/unix/mphalport.h`. R2 REMOVED the `mp_hal_ticks_ms() { return 0; }` stub (see `mphal.c`) and added the `mp_hal_get_random` declaration. |
| `mphal.c` | port-local (new, R2) | The HAL clock and entropy source. `ticks_ms/us/cpu` over `CLOCK_MONOTONIC`, `time_ns` over `CLOCK_REALTIME`, `delay_ms` chunked at 50 ms so a cooperative signal is claimed *during* a long `time.sleep`, and `mp_hal_get_random` reading `/dev/urandom` (a real char device on this image) — raising rather than degrading to a seeded PRNG. Upstream's counterpart is `ports/unix/unix_mphal.c`. These cannot be inlines in `mphalport.h`: `py/mphal.h` includes it having pulled in only `py/mpconfig.h`. |
| `portmodos.c` | port-local (new, R2), bodies from upstream `ports/unix/modos.c` + `extmod/vfs_posix.c` | `MICROPY_PY_OS_INCLUDEFILE`. The env/system/errno bodies are the unix port's minus its `_WIN32` branches; the filesystem half (`listdir`/`ilistdir`/`mkdir`/`rmdir`/`remove`/`rename`/`stat`/`lstat`/`chdir`/`getcwd`/`symlink`/`readlink`) is `vfs_posix.c`'s with the VFS `self`/root-prefix plumbing dropped — the same "lift it out of the VFS" move `file.c` made in R1, for the same reason. `os.path` is new code with no upstream counterpart. |
| `portmodtime.c` | port-local (new, R2) | `MICROPY_PY_TIME_INCLUDEFILE` — the two hooks `extmod/modtime.c` asks the port for. Much smaller than upstream's `ports/unix/modtime.c`, which also overrides sleep with a `select(2)` loop. |
| `extmod/modos.c` | upstream | ONE hunk: a `#if MICROPY_PY_OS_POSIX_FS` block in the globals table, binding the same names upstream binds under `#if MICROPY_VFS` to `portmodos.c`'s POSIX bodies, plus `os.path`. |
| `extmod/modrandom.c` | upstream | ONE line: `#include "py/mphal.h"`, because `MICROPY_PY_RANDOM_SEED_INIT_FUNC` is `mp_hal_time_ns()` and this file includes only `py/runtime.h`. |
| `extmod/modplatform.h` | upstream | `#ifndef` guards around the arch / system / libc detection chains so `mpconfigport.h` can pin them. wasm32 matches none of upstream's tests, so unpatched the header defines all three to `""` and `platform.platform()` renders as `MicroPython-1.28.0---with-`. |
| `extmod/{modjson,modre,modtime,modrandom,modbinascii,modheapq,modplatform}.c`, `extmod/{misc,vfs,modtime,modplatform}.h` | upstream | Verbatim. |
| `lib/re1.5/*` | upstream (BSD, `LICENSE` vendored alongside) | Verbatim. NB the three `.c` files are `#include`d by `extmod/modre.c` and must NOT be listed in `bin.json` as separate translation units. |
| `shared/timeutils/*` | upstream | Verbatim. |
| `mpconfigport.h` | port-local | See "Config choice". Heap is 32 MB on wasm. |
| `uart_core.c` | upstream `ports/minimal/uart_core.c` | `mp_hal_stdin_rx_chr` returns Ctrl-D on a 0-byte read, so piped stdin terminates the REPL instead of spinning at 100% CPU. |
| `test_bin.json` | port-local | Was a second *main* (`test_main.c`, since deleted); R1 unified it onto `main.c`. |
| `_frozen_mpy.c` | upstream `ports/minimal` frozen output | Guard relaxed: the original demanded `MICROPY_LONGINT_IMPL == 0`; this module freezes no big-int constants, so any impl is compatible (comment in the file). Excluded from the qstr scan — it defines its own qstrs as an enum extending `MP_QSTRnumber_of`. |
| `genhdr/*` | generated | See "Regenerating genhdr/". Before R1 these carried hand-written "Hand-extended…" blocks; the regenerator supersedes them. |
| `extmod/`, `shared/`, `py/` | upstream | Pruned to the files `bin.json` lists; contents verbatim. |

## Known gaps

- **`python` is a MicroPython dialect, not CPython.** No `pip`, no C-extension
  packages, and a curated stdlib. This is documented, not a bug —
  `todos/0117`'s "Why". gucOS now has a second, independent python route as
  well (`todos/CPYTHON.md`); which one the bare `python` command runs is the
  dispatcher's business, `todos/0338`.
- **Modules a Python programmer will reach for and not find**: `datetime`,
  `argparse`, `subprocess`, `hashlib`, `select`, `socket`, `deflate`. These
  are NOT free the way R2's set was. `hashlib` and `deflate` each pull a new
  third-party library into `lib/` (crypto-algorithms/axtls, uzlib), which is a
  supply-chain addition with its own provenance bookkeeping rather than a
  config flip. `select` needs `MP_STREAM_POLL` wired through `file.c` to the
  kernel's `FS_SELECT`/`FS_WAIT` — worth doing properly, because a `select`
  that does not compose with the kernel's unified WAIT (`todos/0178`) would be
  a busy-poll wearing a `select` costume. `subprocess` wants a shim over
  `__spawn` (`os.system` is the whole story today). `datetime`/`argparse` are
  pure Python and want the micropython-lib vendoring question answered first.
  All of it is `todos/0117` R3, demand-driven.
- **`time.localtime` is `time.gmtime`.** There is no timezone database on this
  OS and the kernel clock is UTC, so a script that formats a local timestamp
  gets UTC. Honest UTC beats a fabricated fixed offset, but a script that
  prints "your appointment is at 14:00" is still wrong for most readers.
- **`os.statvfs` is absent**, deliberately: the libc's `statvfs` reports a
  fixed nominal 4 GiB volume (see `LIABILITIES.md` L15), so exposing it would
  hand Python a number that looks like free space and is not.
- **`os.sync()` is absent**, deliberately: upstream's body only syncs FatFS
  volumes, so with no VFS it is an unconditional no-op. Durability here is the
  file object's `.flush()`, which is a real kernel `FS_FSYNC` (`todos/0036`).
- **`cmath` results differ from CPython in the last bits.** `cmath.sqrt(-1)`
  is `(6.123233995736766e-17+1j)`, not CPython's exact `1j` — MicroPython
  computes the root in polar form. Arithmetic is right to within a rounding
  error; the *printed* form is not identical.
- **`os.ilistdir`'s inode field is always 0.** The gucOS libc's `readdir` does
  not carry inode numbers (its own header says so); `os.stat` is where an
  inode comes from.

## GC cost of the 32 MB heap

MicroPython's collector is a stop-the-world mark-sweep, so the heap bump was
measured, not assumed (method + raw numbers in
`logs/2026-07-27/0117-micropython-script-runner.md`):

| heap | live data | mean pause |
| --- | --- | --- |
| 256 KB | ~0 | < 5 µs |
| 256 KB | 130 KB | 190 µs |
| 32 MB | ~0 | **5 µs** |
| 32 MB | 5.7 MB | 11.5 ms |
| 32 MB | 19.5 MB | 34 ms |

The pause tracks **live data** (~1.7 ms/MB), not heap size: enlarging an empty
heap from 256 KB to 32 MB costs ~5 µs per collect. A script that actually holds
20 MB live pays ~34 ms — which is the price of holding 20 MB, and at 256 KB the
alternative was not a shorter pause but `MemoryError`.
