# vendor/cpython — CPython 3.13.5, gucOS port

**Upstream pin**: `python/cpython`, tag **v3.13.5** (`Include/patchlevel.h`:
`PY_VERSION "3.13.5"`).
**Design**: `todos/CPYTHON.md` is normative — module-selection rule, extension
set, prefix layout, package shape. **Execution ticket**: `todos/0340`.
**Probe narrative**: `logs/2026-07-28/m1-clang-stdlib-design.md`;
landing log: `logs/2026-07-28/0340-cpython-vendor-tree.md`.

Two consumers, one tree. The clang toolchain (`cc2wasm`, via the sibling
`clang-simplified` repo's `wasm/image/manifest.json`) builds it today; the
`compiler.js` build reads `bin.json` and is gated on `todos/0336`. Everything
here except the two clang-only items in §4 is shared.

**Honesty, verbatim, wherever this port is described**: there are no sockets
(`_socket` is not built), so **`asyncio` does not import and is not
shipping-functional**; no `ssl`, no `https`, no `pip`; and **no `ctypes`,
permanently** — gucOS has no `dlopen` and that is a settled platform decision
(`todos/OS.md`), not a backlog item.

## 1. Layout

```
gen/                 the wasi-configure-generated inputs, committed
  pyconfig.h           + the gucOS deltas of §3
  Modules/config.c     the builtin-module table (§2) — the ONE place the
                       statically linked extension set is written down
  Python/frozen_modules/*.h   24 frozen modules
  shim/                ccprobe_libc.{h,c} (libc surface compiler.js lacks),
                       stdatomic.h, ccprobe_clang.h (clang-only, §4)
Include/ Objects/ Python/ Parser/ Modules/ Programs/
                     pruned upstream sources: the srcs.txt TU list plus every
                     file those TUs transitively #include, and nothing else
Lib/                 the §5 module set, verbatim upstream + the §3 Lib patches
srcs.txt             the TU list both toolchains consume (249 entries)
bin.json             the compiler.js build (sources + includes + defines)
```

`gen/` is committed for the same reason `vendor/micropython/genhdr` is: those
files are a function of *(CPython version, target config)*, not of a build
host. At one version pin the churn is nil.

**How the prune was computed** (reproducible, not hand-curated): each TU in
`srcs.txt` was run through `clang -M` with the exact include set and defines of
the real build; every dependency resolving inside the upstream tree was
copied, everything else dropped. 249 TUs → **649 files, 17.7 MiB** of sources.
Re-deriving after a version bump means re-running that scan, not re-reading
this list.

## 2. The extension set (`gen/Modules/config.c`)

No `dlopen` means every C extension is **statically linked into the binary**
and registered in the inittab. Beyond the wasi configure's core set, this tree
adds 31:

`math` `cmath` `_struct` `_opcode` `_random` `_contextvars` `_csv` `binascii`
`array` `_heapq` `_bisect` `_datetime` `_json` `_pickle` `select` `_lsprof`
`_statistics` `unicodedata` `_md5` `_sha1` `_sha2` `_sha3` `_blake2` `pyexpat`
`_elementtree` `_zoneinfo` — the CPYTHON.md §3.2 Tier-1 set — plus **`fcntl`**,
**`termios`**, **`zlib`** (against the in-repo `vendor/zlib`) and the two
Tier-2 modules below.

### Tier 2 — admitted on measured deltas

CPYTHON.md §3.3 gates `_sqlite3` and `_decimal` on their measured cost. Both
were built and weighed on 2026-07-28 against the same tree with everything else
identical:

| module | binary | Δ binary | gzip -9 | Δ gzip | verdict |
|---|---|---|---|---|---|
| *(neither)* | 6,190,849 | — | 1,756,968 | — | baseline |
| `+_decimal` | 6,449,796 | **+258,947 (+4.2 %)** | 1,821,081 | **+64,113 (+3.6 %)** | **IN** |
| `+_sqlite3` | 7,364,271 | **+1,173,422 (+19.0 %)** | 2,190,333 | **+433,365 (+24.7 %)** | **IN** |
| both | 7,622,391 | +1,431,542 | 2,253,032 | +496,064 | — |

All four rows were built by the same script into the same output path, so the
deltas are like-for-like. (They are ~14 KB below the shipped payload's
7,636,885: the published build adds `HAVE_PIPE`/`HAVE_DUP`/`HAVE_DUP2` and
links from a different output path, which `todos/0349` records as embedded in
the payload. Comparing sizes across directories measures the path — comparing
the deltas within this series does not.)

`_decimal` is cheap and **8.8× faster** than the `_pydecimal` fallback on a
20k-iteration `Decimal` add/divide loop (0.037 s vs 0.326 s, same binary
otherwise). `_sqlite3` is the expensive one: it is IN because `import sqlite3`
failing is exactly the kind of hole that breaks an unmodified third-party
script, it links the **already-vendored, already-ported** `vendor/sqlite`
amalgamation (no new vendor weight, no new porting risk), and 433 KB on a
2.25 MB opt-in download is proportionate. Reversing either is one row in
`gen/Modules/config.c` plus its lines in `srcs.txt`.

`_socket`, `_ssl`, `_hashlib`, `_bz2`, `_lzma`, `_ctypes`, `_curses`,
`_posixsubprocess`, `_tkinter` are **not** built; causes and unblock paths are
CPYTHON.md §3.3.

## 3. Patch table

Complete. Everything else in this tree is byte-for-byte upstream v3.13.5.

| file | patch | why |
|---|---|---|
| `Modules/expat/{xmlparse,xmlrole,xmltok}.c` | `#undef PREFIX` prelude | the build defines `-DPREFIX="/usr/local"` for `Modules/getpath.c`; expat uses `PREFIX` as its own name-mangling macro, and the command line wins. (`xmltok.c` has an upstream `#undef PREFIX`, but it sits *after* the first uses.) |
| `Modules/fcntlmodule.c` | `(void *)(intptr_t)` cast at the `ioctl` call + `<stdint.h>` | POSIX declares `ioctl` variadic; this libc declares `ioctl(int, unsigned long, void *)`. Whether the libc should go variadic is `todos/0325` Group D; this is the only call site. |
| `Modules/getbuildinfo.c` | `#undef __DATE__` / `#undef __TIME__` prelude | overlay@1 requires byte-reproducible payloads. This replaces the recipe's `-DDATE`/`-DTIME` pin, which could not survive co-linking a library: zlib's `inflate_mode` enum has a member named `TIME`. Same result — the banner reads `xx/xx/xx, xx:xx:xx`. |
| `Modules/posixmodule.c` | add `HAVE_POSIX_SPAWN` to the two `parse_arglist`/`parse_envlist`/`free_string_array` guards | upstream gates those helpers on the execv/spawnv/RTP families, so a `posix_spawn`-without-`exec` configuration — i.e. gucOS — compiles `os.posix_spawn` against three functions the preprocessor removed. |
| `Lib/subprocess.py` | guarded `_posixsubprocess` import; `_use_posix_spawn()` returns True on `gucos`; `_POSIX_SPAWN_SEARCHES_PATH` (use `os.posix_spawnp` for a bare program name); explicit `OSError(ENOTSUP)` where the fork branch would have been | §6 |
| `Lib/_sysconfigdata__gucos_.py` | **new file** | upstream generates it during `make`; there is no `make` here. Without it `sysconfig` raises at first use and takes `pydoc` and `zoneinfo` with it. |
| `gen/pyconfig.h` | see §4 | configuration, not code |

## 4. `gen/pyconfig.h` deltas

Each of these is a configure knob whose honest value differs from what the
wasi-sdk configure produced:

| knob | value | why |
|---|---|---|
| `HAVE_POSIX_SPAWN`, `HAVE_POSIX_SPAWNP` | 1 | the libc ships the whole family; this is gucOS's *only* process-creation primitive |
| `HAVE_POSIX_SPAWN_FILE_ACTIONS_ADDCLOSEFROM_NP` | 1 | added to the libc by `todos/0340`; it is what makes CPython's `close_fds=True` **default** reachable without `fork` |
| `HAVE_SIGSET_T` | 1 | was never emitted at all, so `posix_spawn(setsigdef=…)` raised `NotImplementedError` — which every `subprocess.run()` hits via its default `restore_signals=True` |
| `HAVE_SYS_WAIT_H`, `HAVE_WAITPID` | 1 | the libc has both; without them `os.waitpid` is absent and `subprocess`, `venv`, `webbrowser`, `pty` all fail to import |
| `HAVE_PIPE`, `HAVE_DUP`, `HAVE_DUP2` | 1 | gucOS pipes are real kernel objects with an SPSC fast path (`todos/0181`). Without `os.pipe` every `subprocess.run(capture_output=True)` dies in `_get_handles` |
| `HAVE_KILL`, `HAVE_KILLPG` | 1 | real, kernel-routed; `Popen.terminate()`/`kill()` need `os.kill` |
| `HAVE_PTY_H`, `HAVE_OPENPTY` | 1 | gucOS ptys are real kernel objects (`todos/0020`) |
| `HAVE_TERMIOS_H` | 1 | the `termios` extension is now built |

Deliberately still off: `HAVE_EXECV`/`HAVE_FORK` (they do not exist here),
`POSIX_SPAWN_SETSID` and the `SETSCHED*` flags (CPython `#ifdef`s on exactly
those names and turns an absent one into an honest "unsupported on this system"
error, which beats accepting an argument and ignoring it).

**Clang-only**, i.e. not shared with the `compiler.js` build:
`gen/shim/ccprobe_clang.h` (neutralises `__minstack`, which is a compiler.js
dialect directive; clang takes `-Wl,-z,stack-size=8388608` instead) and
`-Dwcstol=__ccprobe_wcstol`, which keeps the shim's `wcstol` from colliding
with the sibling's `libc-ext/__wcsto.c` — both projects independently filled
the same `compiler.js` hole (`todos/0325` Group A retires both copies).

**The flag list is written twice** — `bin.json` for `compiler.js`, the sibling
manifest's `cc2wasmFlags` for `cc2wasm` — because the two build systems have
no common format. They must stay in step; `bin.json` is the reference copy.

## 5. What ships under `Lib/`

The rule (CPYTHON.md §2) is an **exclusion list**, not an allowlist: everything
under upstream `Lib/` ships except `test/`, `idlelib/`, `tkinter/`,
`turtledemo/`, `turtle.py`, `ensurepip/` and `__pycache__/`. A module whose C
extension is missing ships anyway, fails with an honest `ModuleNotFoundError`,
costs only its file size, and starts working the day its extension lands — with
no re-curation. Measured: **548 files, 9,914,191 bytes** (534 `.py`; the 14
others are venv activation scripts, two `mypy.ini`, a `.css`, a `.rst` and the
macholib helpers).

## 6. `subprocess` without `fork`

gucOS's process model *is* owner-brokered `posix_spawn` (`todos/OS.md` — `fork`
is deliberately absent), and `subprocess.py` already contains a complete
`os.posix_spawn` path. Four things had to line up, and all four are in this
tree rather than papered over:

1. `_posixsubprocess` is **never built** and never stubbed. The import is
   guarded; `_can_fork_exec` stays True because gucOS genuinely *has*
   processes (it is not upstream's emscripten/wasi "no processes at all"
   case); the fork branch raises a specific `OSError(ENOTSUP)` naming the
   arguments that disqualified the call.
2. `_use_posix_spawn()` returns True on `gucos` — checked *before* the
   `_PYTHON_SUBPROCESS_USE_POSIX_SPAWN` override, because no environment
   variable can conjure a `fork()` to fall back to.
3. A bare program name (`subprocess.run(["ls"])`) goes through
   `os.posix_spawnp`, which searches `PATH`. Upstream routes that case to
   `fork_exec` purely because `os.posix_spawn` does not.
4. `close_fds=True` — CPython's **default** — needs `POSIX_SPAWN_CLOSEFROM`.
   `todos/0340` implemented it for real: `posix_spawn_file_actions_addclosefrom_np`
   in the libc travels as fd-action op 3, and the kernel (which is the side that
   actually knows which descriptors are open) enumerates and drops them at
   spawn. It is not a Python-side workaround and it benefits every gucOS
   program, not just this one.

## 7. Verified on 2026-07-28

Against this tree, no environment variables set, binary at `<prefix>/bin/`:

- **166 of 180** shippable top-level stdlib modules import. All 14 failures are
  named §3.3 causes: `_socket` (8 modules), `_bz2`, `_lzma`, `_ctypes`,
  `_curses`, `_ssl`.
- Landmark `sys.path` discovery with **zero** env vars, including through a
  symlinked `argv[0]`.
- `sys.platform == "gucos"`; banner reports Clang and `xx/xx/xx, xx:xx:xx`.
- Functional: `math` `struct` `hashlib`(sha2/sha3/blake2/md5) `datetime`
  `random` `csv` `array` `unicodedata` `statistics` `decimal`(C) `base64`
  `pickle` `xml.etree` `inspect` `dis` `unittest` `dataclasses` `pathlib`
  `zlib` `gzip` `zipfile`(deflate) `binascii.crc32` `sysconfig` `pydoc`
  `zoneinfo` `sqlite3` `tty` `termios` `fcntl` `pty`.
- Binary **7,636,885 B**, gzip -9 **2,254,132 B**; the gucman package is
  **4,603,396 B** downloaded / **17,557,740 B** installed over 552 files.
- **Byte-reproducible**: two full publishes into the same path produced the
  same sha256 (`7daa8881…`). Payloads embed their build path (`todos/0349`), so
  that comparison is only meaningful built in the same directory — it was.
- All 42 legs of `tests/kernel/test_python_clang_e2e.js` pass IN-OS, including
  the same 166/180 sweep over the kernel's RemoteFS.
