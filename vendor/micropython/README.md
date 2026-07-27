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

The current feature set is the `todos/0117` **Round 1** target: a real script
runner with file I/O. Stdlib breadth (`os`, `json`, `time`, `re`, `struct`,
`array`, `gc`, `sys.modules`) is deliberately still off — that is R2, parked
pending the `todos/0313` CPython probe.

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
| `main.c` | upstream `ports/minimal/main.c` | Rewritten into the gucOS CLI driver (`todos/0117` R1): argv grammar (`script args…`, `-c cmd`, `-`, `-h`, `-V`), `sys.argv`, exit statuses (`sys.exit`, uncaught exception → 1, usage → 2), tracebacks to `MICROPY_ERROR_PRINTER`, stdin-as-script when stdin is not a tty, `mp_import_stat` over POSIX `stat`, `mp_stderr_print`, `__minstack(1048576)`. The `gc_dump_info()` call inside `gc_collect()` is dropped (it printed GC stats into program output on every collection). The dead `MICROPY_MIN_USE_CORTEX_CPU` / `MICROPY_MIN_USE_STM32_MCU` blocks are kept verbatim. `do_*` shapes follow `ports/unix/main.c`. |
| `file.c` | upstream `extmod/vfs_posix_file.c` | Port-local derivative. The VFS gate (`MICROPY_VFS_POSIX`) becomes `MICROPY_PY_BUILTINS_OPEN`; the `extmod/vfs_posix.h` include is dropped; the `vfs_` prefix is dropped from the C symbols; the win32/macOS `fsync` special cases, the `MICROPY_PY_OS_DUPTERM` write shortcut and the `MICROPY_PY_SELECT` poll branch are removed (one target, none of those configs). `mp_builtin_open` — which upstream gets from `extmod/vfs.c`'s `mp_vfs_open` — is added at the bottom with the same `(file, mode, buffering, encoding)` signature. **The file struct's tag is `_mp_dummy_t` on purpose**: `py/modsys.c` and `py/modbuiltins.c` reach the `sys.std*` objects through `extern struct _mp_dummy_t` ("type is irrelevant, just need pointer"), and compiler.js's linker — unlike a C linker — rejects a cross-TU type conflict. |
| `mphalport.h` | port-local | Added `MP_HAL_RETRY_SYSCALL`, verbatim from upstream `ports/unix/mphalport.h`. |
| `mpconfigport.h` | port-local | See "Config choice". Heap is 32 MB on wasm. |
| `uart_core.c` | upstream `ports/minimal/uart_core.c` | `mp_hal_stdin_rx_chr` returns Ctrl-D on a 0-byte read, so piped stdin terminates the REPL instead of spinning at 100% CPU. |
| `test_bin.json` | port-local | Was a second *main* (`test_main.c`, since deleted); R1 unified it onto `main.c`. |
| `_frozen_mpy.c` | upstream `ports/minimal` frozen output | Guard relaxed: the original demanded `MICROPY_LONGINT_IMPL == 0`; this module freezes no big-int constants, so any impl is compatible (comment in the file). Excluded from the qstr scan — it defines its own qstrs as an enum extending `MP_QSTRnumber_of`. |
| `genhdr/*` | generated | See "Regenerating genhdr/". Before R1 these carried hand-written "Hand-extended…" blocks; the regenerator supersedes them. |
| `extmod/`, `shared/`, `py/` | upstream | Pruned to the files `bin.json` lists; contents verbatim. |

## Known gaps

- **`python` is a MicroPython dialect, not CPython.** No `pip`, no C-extension
  packages, and a curated (currently very small) stdlib. This is documented,
  not a bug — `todos/0117`'s "Why".
- **No `-m`.** Rejected with a usage error rather than silently treated as a
  filename; module execution wants the R2 import work.
- **`sys.path[0]` is `""` (cwd), not the script's directory** as CPython does.
  R2 owns the `sys.path` / site-dir design.

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
