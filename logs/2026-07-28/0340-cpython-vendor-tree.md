# todos/0340 — vendoring CPython 3.13.5 and shipping `python-clang`

Lane `0340-cpython` (sibling: `clang-simplified` branch `0340-cpython`),
2026-07-28. `todos/CPYTHON.md` was normative and its structure held end to end;
this log is the *why* behind the places where building it taught us something
the host-side design pass could not see.

## The headline: an in-OS-only P0 that made the whole stdlib unimportable

The design's §9 said in-OS verification was "none expected novel". It was not.

First boot with the package installed: `python-clang -c "print(1+1)"` died with
`ModuleNotFoundError: No module named 'encodings'` — the classic
stdlib-path-wiring symptom, and the exact trap
`logs/2026-07-27/cpython-m0-reprobe-harness.md` warns about. But every wiring
theory was wrong: the files were there (`ls` listed 183 entries), `stat`
reported the directory correctly, `PYTHONHOME` changed nothing, and a
four-entry hand-built mini stdlib failed the same way. `python -vv` was what
broke it open: the importer printed `trying …/encodings.py` and
`trying …/encodings.pyc` but **never tried the `encodings/` directory**. In
`importlib._bootstrap_external`, both branches read one cache that
`FileFinder._fill_cache` fills from `_os.listdir`, and the "trying" lines print
whether or not the cache hit. So the cache was empty: `os.listdir` was
returning nothing.

A ten-line C probe compiled in-OS gave the answer directly:

```
COUNT 185 errno_at_end=5
```

`readdir` walked the whole directory correctly — and left `errno = EIO` at
end-of-directory. POSIX is explicit that `readdir` must not touch errno there,
precisely because the documented way to read a directory is

```c
errno = 0;
while ((e = readdir(d))) { … }
if (errno) /* real error */;
```

and CPython's `Modules/posixmodule.c` `_posix_listdir` is exactly that idiom.
It saw EIO, raised `OSError`, and `_fill_cache`'s `except (FileNotFoundError,
PermissionError, NotADirectoryError)` was near enough to swallow the shape
without the cause ever surfacing.

Root cause, `host.js`: the brokered `__readdir` was wrapped in `wrap()`, which
sets `setErrnoName(self._lastError || 'EIO')` on **every** negative return —
and EOF returns -1 like everything else. The standalone (non-kernel)
`__readdir` a few thousand lines earlier already returned -1 at EOF *without*
setting errno, which is why every host-side probe in the design pass passed and
nothing in-OS could. Two implementations of one contract; only one of them
correct.

The fix takes `__readdir` out of `wrap()` and sets errno only on a real
failure. The regression guard is a C leg in the acceptance test rather than a
Python one, because this is a libc contract every in-OS directory walk depends
on — busybox's `ls` never checked errno, which is why it went unnoticed.

**The transferable lesson**: a helper that maps "negative return" to "set
errno" is wrong for any call whose negative return also means *nothing left*.
`readdir` is the obvious one; it is worth a look at anything else routed
through `wrap()` whose C contract has a non-error negative result.

## What else the build taught us that a read could not

**`-DTIME` cannot be a global define.** The 0331 recipe pinned
`__DATE__`/`__TIME__` from the command line for overlay@1 byte-reproducibility.
That works right up until the link includes another library: zlib's
`inflate_mode` enum has a member named `TIME`, so `-DTIME='"xx:xx:xx"'` turned
it into a string literal and `inflate.c` stopped compiling. The pin moved into
`Modules/getbuildinfo.c` as `#undef __DATE__` / `#undef __TIME__` — same
banner, same reproducibility, and the command line is now clean for every
co-linked library. Verified: two full publishes into the same path, identical
sha256.

**`subprocess.run(["ls"])` needed two things the design did not predict.**
`_USE_POSIX_SPAWN` alone is not enough. Upstream's fast path requires
`os.path.dirname(executable)` to be non-empty (because `os.posix_spawn` does
not search `PATH`) and `close_fds` to be False unless `POSIX_SPAWN_CLOSEFROM`
exists. Both would have been trivially "fixable" in the Python patch by
loosening the conditions and lying; both were instead made true:
`os.posix_spawnp` handles the bare name, and
`posix_spawn_file_actions_addclosefrom_np` was implemented for real as fd-action
op 3, with the kernel — the only party that knows which descriptors are open —
enumerating and dropping them at spawn. That is now a gucOS capability any
program can use, not a CPython accommodation. `HAVE_SIGSET_T` was a third
surprise: the configure never emitted it at all, so `posix_spawn(setsigdef=…)`
raised `NotImplementedError`, which `restore_signals=True` (the default) hits on
every `subprocess.run`.

**`os.waitpid`, `os.pipe`, `os.kill` were all off** in the generated
`pyconfig.h` despite the libc having every one of them. Each absence cost
several stdlib modules (`subprocess`, `venv`, `webbrowser`, `pty`) and each was
found by an import sweep or a traceback, not by reading. The as-built table of
every flipped knob, with the reason, is `vendor/cpython/README.md` §4 — a
generated `pyconfig.h` from a foreign configure is a *starting point*, not a
description of this platform.

**A probe run pollutes the tree it probes.** Running the interpreter against
`vendor/cpython/Lib` through a symlink wrote 209 `.pyc` files into 34
`__pycache__` directories, and the first package build shipped all of them
(761 files / 23.4 MB instead of 552 / 17.6 MB). The package now excludes
`__pycache__` explicitly and `.gitignore` covers the tree. This is also the
concrete demonstration of why §5.3's `PYTHONPYCACHEPREFIX` exists: with caches
under `/opt`, gucman's checksum-gated remove left the whole skeleton behind —
the e2e's "`/opt` tree is gone after remove" leg failed exactly that way before
the launcher's env var was in play.

## Tier 2: measured, then admitted

CPYTHON.md §3.3 left `_sqlite3` and `_decimal` gated on measurement. Built both,
same script, same output path (`todos/0349`: payloads embed their build path, so
a cross-directory byte or size comparison measures the path):

| | binary | Δ | gzip -9 | Δ |
|---|---|---|---|---|
| baseline | 6,190,849 | — | 1,756,968 | — |
| `+_decimal` | 6,449,796 | +258,947 (+4.2 %) | 1,821,081 | +64,113 (+3.6 %) |
| `+_sqlite3` | 7,364,271 | +1,173,422 (+19.0 %) | 2,190,333 | +433,365 (+24.7 %) |

`_decimal` was easy: 4 % for the C implementation, measured 8.8× faster than
`_pydecimal` on a 20k-iteration add/divide loop. `_sqlite3` is the judgement
call, and it went IN: the package's whole thesis is "real CPython, runs
unmodified", `import sqlite3` failing is exactly the hole that breaks a
third-party script, the amalgamation is already vendored and already ported so
there is no new porting risk, and 433 KB on a 2.25 MB opt-in download is
proportionate. Both are one row in `gen/Modules/config.c` to reverse, and the
numbers are in the README so the decision stays reviewable.

## Pruning by dependency scan, not by hand

The vendor tree is "the TU list plus everything it transitively includes", and
that was computed rather than curated: every one of the 249 TUs went through
`clang -M` with the real build's include set and defines, and each dependency
resolving inside the upstream tree was copied. 649 files, 17.7 MiB. After a
version bump the instruction is "re-run the scan", not "re-read the list" —
which is the same reason `gen/` is committed rather than regenerated.

## Honesty that travels

Unchanged and repeated wherever the package is described: **no `_socket`, so
`asyncio` does not import and is not shipping-functional**; no `ssl`, no
`https`, no `pip`; **no `ctypes`, ever** (no `dlopen`, settled). The import
sweep is **166 of 180 measured in-OS**, and the acceptance test fails if any
failure falls outside CPYTHON.md §3.3's named causes — so the casualty table
cannot rot into a claim nobody re-checks.
