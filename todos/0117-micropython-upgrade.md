# 0117 — MicroPython: script runner + FS import (multi-round, unlocks /bin/python)

- **Status**: open — **R1 LANDED 2026-07-27; R2 LANDED 2026-07-28** (merged
  `a57673ca`, shipped as micropython package **1.28-3**, edge-verified 16/16).
  **EVERY FUNDED ROUND HAS SHIPPED.** What remains is Round 3+, which is
  explicitly demand-driven ("driven by demand, not speculation") and has no
  named demand — so master cont-113 **demoted this P0 → P3 on 2026-07-28**.
  It had been sitting at **rank 1 of 91, `ready`**, where its own line 3 still
  read "R2 is the remaining work" while §R2 below read "DONE": a lane taking
  the top ready item would have re-done shipped work. jku's foregrounding
  instruction (quoted below) is **discharged**, not withdrawn — it bought R1
  and R2 and both landed (META:
  each round is its own commit). **Foregrounded 2026-07-27 on jku's direct
  instruction**
  ("Ok so we're foregrounding all the micropython work right? NetSurf is good but
  this is important too. ... And yea I do want the cli properly fixed as well so
  it actually runs the scripts."). The 2026-07-12 deferral was a mass sweep, not a
  judgement about this item.
- **ROUND SEQUENCING — R1 LANDED; R2 IS UN-PARKED (2026-07-28, decider call):**
  - **R1 (argv/script-runner + `open()`/IO/stdfiles + the two POSIX hooks + the
    heap bump + the `python` alias) is foreground and funded.** It is the leg jku
    named, it is cheap, it pays off regardless of the CPython route.
    Provenance: **(jku decision)**.
  - **⚠️ THE M0 PARK CONDITION NEVER FIRED — do not cite it as R2's reason.**
    The 2026-07-27 park (recorded here, and echoed in `todos/0313`'s "R2: KEEP
    PARKED") was conditional on exactly one question: *is a real CPython
    `/bin/python` buildable with our compiler?* M0 answered **yes** — and M1-clang
    then went further and built one (a 4,529,136 B CPython 3.13.5 wasm at
    functional parity; recipe `logs/2026-07-27/python-clang-build.sh`, vendor-tree
    design `todos/CPYTHON.md` + `todos/0340`). So the condition resolved in the
    direction that KEEPS the park. **R2 un-parks anyway, for different reasons.**
    This paragraph exists so the next reader cannot mistake an un-fired condition
    for a fired one and cancel R2 on a sound-looking argument.
  - **Why R2 un-parks, in strength order:**
    1. **The one-implementation premise is gone.** The park's whole logic was
       "a real CPython `/bin/python` makes MicroPython breadth redundant" —
       redundancy that only exists if exactly one implementation may own the
       name. jku replaced that model with a **dispatcher**: bare `python` is a
       base-image command that forwards to whichever implementation the user
       picked (`todos/COMMAND-ALTERNATIVES.md`, `todos/0338`). Implementations
       now coexist by design, so breadth in one does not subtract from another.
       His words (email, 2026-07-27): the goal is "a python that has the highest
       chance of being able to support pygame in the future", and he "wants all
       implementations eventually caught up" — *caught up*, not *replaced*.
    2. **MicroPython is the only python implementation that actually ships
       today.** cpython-clang's (né python-clang, todos/0374) binary half is done, but its vendor tree + stdlib
       layout is a separate in-flight lane (`todos/0340`). Whatever a user can
       install first is MicroPython.
    3. **A python that cannot `import json` is a footgun no matter which
       implementation is default.** R1 made it a real script runner; R2 is what
       makes it a real *python*.
  - **Audience, stated accurately** (an earlier framing of this said "the
    base-image `python` is MicroPython, so R2's breadth is the DEFAULT
    experience" — that is **false** and must not be repeated): gucOS ships **no
    `python` verb at all** in the base image, and MicroPython is **not** baked
    into it. Measured, not assumed — a BlockFS walk over the live deployed image
    enumerated 240 entries with **0 hits for `python` and 0 for `micro`** (`lua`
    and `sqlite` also 0, the cross-check: both are likewise packages), and
    `grep -in python os/image.json` at the deployed v177 commit is empty.
    MicroPython is a **gucman package**; a fresh gucOS has no python until
    `gucman install micropython`. jku is additionally leaning toward
    cpython-clang (then named python-clang) as the *suggested* python when none is installed. ⇒ the correct
    form is **"MicroPython is gucOS's python for users who have installed it."**
  - Provenance: R2 un-park = **(decider call)**, 2026-07-28. Not a jku ruling —
    he may still overturn it.
- **The `python` alias is INTERIM, not a ratified end state.** R1 shipped
  `/usr/local/bin/python` → the MicroPython binary (`packages/micropython.json`
  `bin` map). Decider verdict D6 previously recorded that alias as
  *ratified-deliberate*; that is **SUPERSEDED**. jku ruled (email, 2026-07-27;
  provenance **(jku decision)**; authority
  `~/git/meta/meta/notes/fable-decider-python-primary-2026-07-27.md` §*jku
  OVERRIDE of D4/D6* — later sections of that note supersede earlier ones) that
  bare `python` must be a **base-image dispatcher** forwarding all args to the
  user's chosen implementation, erroring *"no python implementation installed"*
  when none is present and switchable in the control panel. The alias is
  retired by `todos/0338`, and dropping it from `packages/micropython.json` is
  **release-atomic with that landing** — it belongs to 0338's commit, not to
  R2's. Design: `todos/COMMAND-ALTERNATIVES.md`.
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

**Round 2 — search path + a usable stdlib slice.** — DONE 2026-07-28, see below.

## R2 — DONE 2026-07-28

- **The plan's premise was wrong in a way worth recording.** It said "the
  minimal port ships `math`/`sys`/`gc`/`array`/`collections`/`struct`/
  `errno`/…". Measured: the built-in module set was **`math`, `io`, `sys`,
  `builtins`** and nothing else. `py/modstruct.c`, `modarray.c`,
  `modcollections.c`, `modgc.c`, `moderrno.c` were all in `bin.json` and all
  compiling to EMPTY translation units, because `MICROPY_CONFIG_ROM_LEVEL_MINIMUM`
  gates them at CORE/EXTRA. So four of the "already shipped" modules were part
  of R2's work, and they cost one `#define` each.
- **Module set** (rationale table in `vendor/micropython/README.md`): the four
  above + `micropython`/`cmath`, then `os` (+ a real `os.path` submodule),
  `json`, `time`, `re`, `random`, `binascii`, `heapq`, `platform` vendored from
  upstream `extmod/`, plus `sys.modules`. Deliberately NOT taken: `hashlib`,
  `deflate`, `select`, `socket`, `datetime`, `argparse`, `subprocess` — each
  needs a new vendored third-party library, a kernel seam, or the
  micropython-lib question answered; register entry **L43**, R3 owns them.
- **`os` is upstream's `extmod/modos.c` + a port `portmodos.c` includefile**,
  not a rewrite. Upstream reaches the filesystem only through the VFS, which
  this port deliberately does not have (the kernel owns mounting), so every FS
  name in its globals table sits behind `#if MICROPY_VFS`. The patch is ONE
  hunk binding the same names to POSIX bodies — the R1 `file.c` decision
  applied to directories. `os.path` is new: a real submodule
  (`MICROPY_MODULE_BUILTIN_SUBPACKAGES`), so `import os.path` and
  `from os.path import join` work.
- **`sys.path` policy**: `[<script's dir> | "", ".frozen",
  /usr/local/lib/micropython, <dir of the real binary>/lib]`. The site dir is
  under `/usr/local` because `/usr` is a sealed read-only volume (0040) — a
  site dir there could never be written to. It precedes the package's own lib,
  which diverges from CPython (stdlib before site-packages) and agrees with
  every other layered lookup in gucOS. The package lib is DERIVED from
  argv[0]'s symlink-chased directory, because micropython is a gucman package
  and lives at `/opt/micropython` or `/usr/opt/micropython` depending on how it
  got there.
- **`-m` landed too** (register entry L36 retired), over upstream's own
  `MICROPY_MODULE_OVERRIDE_MAIN_IMPORT`. R1 refused it because there was no
  module-execution path; there is one now, so refusing it was just a missing
  feature.
- **`mp_hal_ticks_ms` was `return 0`.** A stub nobody called, because `time`
  was not compiled in. Enabling `time` made it load-bearing, and a stubbed tick
  is worse than a missing module: `ticks_diff` returns 0 forever and a script
  waiting on the clock hangs SILENTLY. Real clocks now live in `mphal.c`
  (MONOTONIC for ticks, REALTIME for `time()`), and the epoch is 1970 rather
  than MicroPython's embedded-flavoured 2000, so `time.time()` agrees with
  CPython and with the rest of the OS.
- **A silent generator bug found on the way**: `tools/mkmpgenhdr.js` dropped
  every qstr in a `MICROPY_PY_*_INCLUDEFILE` port source. `makeqstrdefs.py`
  names its per-file buckets after the preprocessor's line markers, so a file
  reached through `-I.` becomes `.__portmodos.c.qstr` — a DOTFILE — and the
  collecting step's `glob("*.qstr")` does not match leading dots. No error;
  just an undeclared `MP_QSTR_x` at link time. mkmpgenhdr un-dots the buckets
  before the collect.
- **The shebang story needs nothing built.** `#!/usr/local/bin/python foo.py`
  already works through 0065's `_spawnShebang` — it re-dispatches to the
  interpreter with the script path as argv[1], which is exactly the CLI R1
  built. Worth saying explicitly because it interacts with `todos/0338`: a
  script whose shebang names the DISPATCHER gets implementation-switching for
  free, and one that names `/usr/local/bin/python` today will follow the
  dispatcher once 0338 lands, since that is the same path.
- Numbers: upstream corpus 537→**580 passing** (3 failed — the same three
  pre-existing float tests, by name — and 108→65 skipped). New tests:
  `tests/kernel/test_micropython_stdlib_e2e.js` (49 checks, spawned through the
  real `/usr/local/bin/python` → `/opt/micropython/micropython` symlink so the
  argv[0] chase is under test) and `tests/micropython/09_stdlib.py`, whose
  golden is generated by real CPython 3 and matched byte for byte.
- Register: L35/L36/L37 retired, **L42** (localtime is gmtime — no timezone
  database) and **L43** (the absent modules) filed.

**Round 3+ (reassess after R2) — dialect breadth as demand appears.**
- More stdlib, `subprocess`-ish spawn shim over `__spawn`, whatever the
  first real in-OS Python scripts actually need. Driven by demand, not
  speculation.

## Acceptance

- R1: `echo 'print("hi")' > /root/t.py && python /root/t.py` prints `hi`;
  `python` with no args is still the REPL; `open('/root/t.py').read()`
  works from the REPL.
- R2: a two-file `import`-ing script runs; a curated `import os, json`
  succeeds. — MET.
- New kernel e2e test alongside `tests/kernel/test_repl_pty_e2e.js`
  (script-file + import legs), plus a note in CLAUDE.md's REPL paragraph
  updating the "argv ignored, no open()/import" description once it's
  false. — MET (`test_micropython_stdlib_e2e.js`; CLAUDE.md rewritten).
- `vendor/micropython/README.md` pinning the config choice + patch list. —
  MET (R1 created it; R2 extended the config/module/patch sections). NB no
  `os/image.json` version bump: micropython is a gucman PACKAGE, so the
  base image is untouched — `packages/micropython.json` carries the version
  (`1.28-3`), and a `dist/packages` rebuild + a fat-image rebake are what a
  vendor change forces.
