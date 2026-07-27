# 0117 — MicroPython: script runner + FS import (multi-round, unlocks /bin/python)

- **Status**: open — **R1 LANDED 2026-07-27**, R2 is the remaining work (META:
  each round is its own commit). **Foregrounded 2026-07-27 on jku's direct
  instruction**
  ("Ok so we're foregrounding all the micropython work right? NetSurf is good but
  this is important too. ... And yea I do want the cli properly fixed as well so
  it actually runs the scripts."). The 2026-07-12 deferral was a mass sweep, not a
  judgement about this item.
- **ROUND SEQUENCING (master, 2026-07-27) — R1 GOES NOW, R2 IS PARKED:**
  - **R1 (argv/script-runner + `open()`/IO/stdfiles + the two POSIX hooks + the
    heap bump + seeding `/bin/python`) is foreground and funded.** It is the leg
    jku named, it is cheap, MicroPython is the OS's scripting language today, it
    pays off regardless of the CPython route, and it is the fallback if the M0
    probe fails.
  - **R2's stdlib breadth is PARKED pending M0** (the "can our compiler build
    CPython core?" probe). *Parked, NOT cancelled* — R2 is the expensive leg and
    is exactly the work a real CPython `/bin/python` would make redundant. **If M0
    reports CPython is not buildable with our compiler, R2 un-parks immediately as
    the real plan, and jku's already-given approval of the module-selection
    approach carries over without a re-ask.** Reason recorded so a later reader can
    tell a fired condition from an open one: the park is conditional on M0 only.
  - Provenance: R1 foreground = **(jku decision)**. R2 park = **(decider call)**,
    routed to jku, not objected to — he may still overturn it.
- **Heap bump target is 32 MB** (`mpconfigport.h:107` is `262144` today, verified
  2026-07-27). Not "several MB" — a 640x480 `array3d` copy is 921 KB, i.e. 3.5x
  the entire current heap, and one float64 temporary is 7.4 MB. **Measure the
  GC-pause consequence** rather than just raising it (a stop-the-world mark-sweep
  is sub-ms noise at 256 KB and plausibly a several-ms hitch at 8 MB+).
- Underneath R1: MicroPython's NLR uses the **setjmp** path on wasm
  (`py/nlrsetjmp.c` in bin.json), so every Python exception is a longjmp — todo
  0312's longjmp hardening (shipped, image v172) is load-bearing here.
- **Design**: this file. Precedent: `todos/done/0036` seeded the REPLs
  (`/bin/micropython`, `/bin/lua`, `/bin/sqlite3`) — deliberately the
  *minimal* MicroPython port.

## Why

`/usr/bin/micropython` (image.json) is MicroPython **1.28.0 minimal port**
— REPL-only and, as shipped, a footgun to alias as `python`:

- `vendor/micropython/main.c` never reads `argc`/`argv` → `micropython
  foo.py` silently drops into the interactive REPL and ignores the file.
- `mp_lexer_new_from_file` is a hard stub raising `OSError(ENOENT)`;
  `mp_import_stat` always returns `MP_IMPORT_STAT_NO_EXIST` → no FS
  `import`, only frozen modules.
- `MICROPY_PY_BUILTINS_OPEN` / `MICROPY_PY_IO` / `MICROPY_PY_SYS_STDFILES`
  are all `0` (`mpconfigport.h`) — no `open()`, no file objects.

So a `python` symlink today would break the single most common thing
anyone types. The goal is to make MicroPython a real script runner over
the OS filesystem, **then** alias `/bin/python` honestly (MicroPython
dialect — curated stdlib, no C-extension packages; that caveat is
documented, not a bug). CPython is explicitly **not** the plan here
(threads dropped per 0006, configure-less build, no dlopen — see WIN32.md's
"rest of Windows" precedent for the same "value/effort is bad" reasoning;
MicroPython is the pragmatic Python story for this constrained,
static-linked, single-threaded world).

## R1 — LANDED 2026-07-27 (branch `micropython-0117`)

What shipped, and the two things a later reader most needs to know:

- **The real blocker was not any of the listed items — it was the QSTR pool.**
  MicroPython's interned-string pool, module table and GC root-pointer list are
  GENERATED from the preprocessed sources + `mpconfigport.h`. This repo commits
  them (`vendor/micropython/genhdr/`) and, before R1, hand-maintained them —
  hence `mpconfigport.h`'s "Enable features that don't need QSTR pool
  regeneration" comment, a config ceiling nobody could raise.
  `tools/mkmpgenhdr.js` now drives upstream's own generators over a `cc -E`
  pass (mirroring `py/mkrules.mk`); its `--check` is a test
  (`micropython/genhdr-sync`). **This is what unblocks R2 too** — the stdlib
  breadth question is now purely "which modules", not "can we".
- `main.c` is the CLI: `script args…`, `-c cmd`, `-`, `-h`, `-V`, `sys.argv`,
  exit statuses, tracebacks on **stderr**. `test_main.c` is GONE — the upstream
  corpus now runs the shipped binary's own code path.
- `file.c` is upstream's `extmod/vfs_posix_file.c` lifted OUT of the VFS (the
  kernel already owns mounting; a second mount table underneath it would be two
  filesystems disagreeing about the same paths) + `mp_builtin_open`.
- Heap 256 KB → 32 MB. **Measured**: the pause tracks LIVE data (~1.7 ms/MB),
  not heap size — an empty 32 MB heap collects in ~5 µs. Table in
  `vendor/micropython/README.md`.
- `/usr/local/bin/python` → the same binary (`packages/micropython.json` `bin`
  map). NB micropython is a gucman PACKAGE, not an `os/image.json` entry — the
  R1-plan line below that says "seed `/bin/python` in image.json" is stale.
- Upstream corpus: 521→**537 passed** (15 recovered skips + the new
  `micropython/genhdr-sync` test), 3 failed (the same pre-existing float
  three), 123→108 skipped. The `/io_` and `/sys_` families and
  `builtin_compile` came off the skip table.
- Also enabled because the ceiling lifted and each is language-completeness,
  not stdlib breadth: `MICROPY_PY_FUNCTION_ATTRS`, `MICROPY_ENABLE_SOURCE_LINE`
  (traceback line numbers), `MICROPY_ENABLE_FINALISER` (a dropped file object
  closes its fd), `MICROPY_MODULE___FILE__`.
- **A side effect worth knowing before scoping R2**: implementing
  `mp_import_stat` properly (R1 item 3) means `import foo` ALREADY finds
  `./foo.py`. What R2 owns is the `sys.path`/site-dir design and the curated
  module set — not the import mechanism.

## Plan (rounds)

**Round 1 — argv + run a script file + basic file I/O.** — DONE, see above.
- Move off the minimal-port config toward the upstream **unix-port**
  config for the file/stream object set (this is adopting an existing
  upstream config, not inventing objects — the unix port already does all
  of this). Keep the build a hand-listed `bin.json` (no configure runner
  in this repo — sqlite/lua precedent).
- Implement `mp_lexer_new_from_file` and `mp_import_stat` against the OS
  filesystem (POSIX `open`/`read`/`stat` via the veneer libc).
- `main.c`: honour argv — `micropython foo.py [args]` compiles+runs the
  file, sets `sys.argv`, exits with its status; no-arg stays the REPL.
- Enable `MICROPY_PY_BUILTINS_OPEN` + `MICROPY_PY_IO` +
  `MICROPY_PY_SYS_STDFILES` and supply the stream objects they need.
- **Then** seed `/bin/python` → `/bin/micropython` in image.json (or a
  thin argv0 alias) and bump the image version.

**Round 2 — FS `import` of real .py modules + a usable stdlib slice.**
- Filesystem module import (`import foo` finds `/…/foo.py`); `sys.path`
  seeded sensibly (cwd + a site dir under `/usr/lib/micropython` or
  similar).
- Curate which built-in modules to compile in (the minimal port ships
  `math`/`sys`/`gc`/`array`/`collections`/`struct`/`errno`/…; decide the
  target set — `os`, `json`, `time`, `re` are the obvious next ones).
- Consider a shebang story: `#!/bin/python` scripts run via the 0065
  `_spawnShebang` path.

**Round 3+ (reassess after R2) — dialect breadth as demand appears.**
- More stdlib, `subprocess`-ish spawn shim over `__spawn`, whatever the
  first real in-OS Python scripts actually need. Driven by demand, not
  speculation.

## Acceptance

- R1: `echo 'print("hi")' > /root/t.py && python /root/t.py` prints `hi`;
  `python` with no args is still the REPL; `open('/root/t.py').read()`
  works from the REPL.
- R2: a two-file `import`-ing script runs; a curated `import os, json`
  succeeds.
- New kernel e2e test alongside `tests/kernel/test_repl_pty_e2e.js`
  (script-file + import legs), plus a note in CLAUDE.md's REPL paragraph
  updating the "argv ignored, no open()/import" description once it's
  false.
- Image version bumped; `vendor/micropython/README.md` created (it's
  currently missing) pinning the config choice + patch list.
