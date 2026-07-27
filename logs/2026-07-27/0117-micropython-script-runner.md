# 0117 R1 — MicroPython becomes a script runner (and 0126's verdict)

Branch `micropython-0117`. Closes `todos/0126` (the difficulty spike); lands
Round 1 of `todos/0117` and leaves R2 parked on `todos/0313`.

## The thing the ticket didn't know: `genhdr/` is a ceiling

Every item R1 listed was cheap. `mp_import_stat` is ten lines of `stat()`.
`mp_lexer_new_from_file` needed **no code at all** — `py/lexer.c` already
defines it under `MICROPY_READER_POSIX` over `py/reader.c`'s POSIX reader, and
both files were already in `bin.json`; the port's job was only to stop
providing the `mp_raise_OSError(MP_ENOENT)` stub that was shadowing it. The
file object is upstream's `extmod/vfs_posix_file.c`. The argv grammar is
`ports/unix/main.c`. The heap is one constant.

What was NOT cheap, and is not mentioned anywhere in 0117, is that
`vendor/micropython/genhdr/*` is **generated**. MicroPython's interned-string
pool (`qstr`), its module registry and its GC root-pointer list are derived at
build time from the PREPROCESSED sources plus `mpconfigport.h`. Upstream
regenerates them every build via `py/mkrules.mk`. This repo has no Makefile for
vendored projects, so the headers are committed — and before this change they
were hand-maintained, with literal `// Hand-extended (the upstream generator
also scans for …)` blocks inside them and a matching comment at the top of the
config:

> `// Enable features that don't need QSTR pool regeneration.`

That is a ceiling on the config, and it sits exactly where R1 needs to go:
`MICROPY_PY_IO` alone wants `StringIO`, `BytesIO`, `readinto`, `readline`,
`getvalue`, `IOBase`, … as interned strings, and a missing one is a link error.

### `tools/mkmpgenhdr.js`

Drives upstream's own scripts — `py/makeqstrdefs.py` (pp/split/cat),
`py/makeqstrdata.py`, `py/makemoduledefs.py`, `py/make_root_pointers.py`,
`py/makecompresseddata.py`, all already vendored — over a `cc -E` pass with
`-DNO_QSTR -D__wasm__`, mirroring `mkrules.mk` step for step. Notes:

- **`_frozen_mpy.c` is excluded from the scan** (upstream's own
  `SRC_QSTR_EXCLUSIONS` does the same): it defines `MP_QSTR_frozentest_dot_py`
  / `_i` / `_interned` as an enum extending `MP_QSTRnumber_of`, so scanning it
  double-defines them. Discovered by diffing the generated pool against the
  committed one — the three extra entries were the tell.
- **The preprocessor is the HOST `cc`, not compiler.js** (which has no `-E`).
  Upstream cross-builds use the target CPP; only `#if` evaluation matters, and
  nothing qstr-bearing branches on host word size. `-D__wasm__` makes
  `mpconfigport.h` take the wasm branch.
- **Both manifests are scanned as a union** (`bin.json` + `test_bin.json`) —
  one committed `genhdr` serves every build of the tree.

**Validation before touching anything:** regenerate at the UNCHANGED config,
rebuild, re-run the 639-file corpus. Result identical to baseline —
521 passed / 3 failed / 123 skipped — so the pipeline is behaviour-preserving
before it is trusted with a config change. The generated `moduledefs.h` and
`root_pointers.h` also matched the committed files' *substance* exactly
(the diff was only the hand-written explanatory comments), which is
independent confirmation the extraction is faithful.

`--check` regenerates into a temp dir and diffs; it is wired into `run.py` as
`micropython/genhdr-sync`, so a forgotten regeneration fails a test instead of
surfacing later as a link error. (Negative-tested: appending one bogus `QDEF1`
to the committed pool turns it red.)

## The port

- **`main.c`** is now the gucOS CLI driver: `script args…`, `-c cmd`, `-`,
  `-h`, `-V`; `sys.argv` per CPython's rules; exit statuses (`sys.exit(N)` → N,
  uncaught exception → 1, usage error → 2); stdin-as-script when stdin is not a
  tty, REPL when it is. Unknown options are **refused loudly** rather than
  treated as filenames — `-m` in particular is a real feature this port does
  not have, and silently trying to open a file called `-m` is the worse answer.
- **`test_main.c` is deleted.** It was a second `main()` that existed only so
  the upstream corpus could pipe a script in without REPL echo — which is
  precisely what the new stdin path does. Unifying them means the 639-file
  corpus now exercises the **shipped binary's own code path**, and there is no
  second main to drift. `test_bin.json` survives only to give the corpus its
  own artifact name.
- **`file.c`** is upstream's `extmod/vfs_posix_file.c` lifted out of the VFS.
  Rationale for not adopting upstream's unix-port config wholesale: that config
  is `MICROPY_VFS` + `MICROPY_VFS_POSIX`, i.e. a mount table *inside*
  MicroPython, and gucOS already has one in the kernel. Two mount tables
  disagreeing about the same paths is a bug generator, so the port takes the
  file object and leaves the VFS. `mp_builtin_open` (upstream gets it from
  `extmod/vfs.c`'s `mp_vfs_open`) is re-provided with the same signature.
- **A compiler.js-specific wrinkle**: `py/modsys.c` and `py/modbuiltins.c`
  reach the `sys.std*` objects through `extern struct _mp_dummy_t
  mp_sys_stdin_obj` — upstream's comment is literally *"type is irrelevant,
  just need pointer"*. A C linker never compares those; **compiler.js's linker
  does**, and rejected the definition as a cross-TU type conflict. The fix is
  to name the real struct's tag `_mp_dummy_t`, which makes the existing
  declarations honest rather than defeating a check that is doing its job.
- **Tracebacks and warnings now go to stderr** (`MICROPY_ERROR_PRINTER`, as
  upstream's unix port does). A CLI that writes errors to stdout corrupts
  `python foo.py > out.txt`. Two upstream tests then "failed" —
  `bytes_compare3` and `exception_chain`, both expecting a `Warning:` line in
  stdout. The goldens are not wrong: **upstream's own `run-tests.py` merges
  stderr into stdout** (`stderr=subprocess.STDOUT`), and ours did not. Fixed in
  the harness, not by moving the warnings back.

## Heap: 256 KB → 32 MB, measured

Method: a throwaway `bench_main.c` (not committed) that runs a workload script
to establish a live set, then times 200 `gc_collect()` calls with
`gettimeofday`, printing the mean.

| heap | live | mean pause |
| --- | --- | --- |
| 256 KB | ~0 | < 5 µs (0 measured over 200 rounds) |
| 256 KB | 130 KB | 190 µs |
| 32 MB | ~0 | **5 µs** |
| 32 MB | 5.7 MB | 11.5 ms |
| 32 MB | 19.5 MB | 34 ms |

**The pause tracks LIVE DATA (~1.7 ms/MB), not heap size.** Enlarging an empty
heap 128× costs ~5 µs per collect — the alloc-table sweep is cheap. The 34 ms
figure is the price of *holding 20 MB live*, which at 256 KB was not a shorter
pause but a `MemoryError`. So the bump is close to free until a script does
something a 256 KB heap could never have done at all.

Worth knowing if a future SDL app ever drives 60 fps from Python: a 20 MB live
set drops ~2 frames per collection. Non-incremental GC is inherent to
MicroPython; no ticket filed because there is no consumer — recorded here and
in the vendor README so the next person has the number instead of a guess.

## Numbers

Upstream corpus (`micropython` + `micropython-upstream`):

| | passed | failed | skipped |
| --- | --- | --- | --- |
| baseline (`origin/main`) | 521 | 3 | 123 |
| after genhdr regen, config unchanged | 521 | 3 | 123 |
| **after R1** | **537** | **3** | **108** |

The +16 is the 15 recovered skips plus the new `micropython/genhdr-sync`
test itself. The 3 failures are the same pre-existing float three
(`builtin_float_round`, `math_domain`, `math_fun_int`) that fail on
`origin/main`. The 15 recovered tests are the `/io_` and `/sys_` families plus
`builtin_compile`, all of which were on the hard-coded skip table with
"flag is off" / "needs QSTR regeneration" as their stated reason.

Note the stragglers *inside* those families — `sys_getsizeof`,
`sys_tracebacklimit`, `io_buffered_writer` — needed no skip entry: they print
`SKIP` themselves, which the runner already honours. A blanket family skip was
hiding the ones that do run; that is the general shape to watch for.

## Also filed

`todos/0318` — `tests/run.js`'s RULES table has **no `vendor/` rule at all**,
so every vendored project reports UNMAPPED on a diff. R1 added the first one
(`^vendor/micropython/`) because its own diff needed it; the rest are still
unmapped. Four liability-register entries (L35–L38) were added for the gaps
this work documents.

## Image version

`os/image.json` **needs a bump** — micropython is a gucman package that folds
into the fat image, and its payload changed. Deliberately NOT bumped here:
executors don't assign image versions.
