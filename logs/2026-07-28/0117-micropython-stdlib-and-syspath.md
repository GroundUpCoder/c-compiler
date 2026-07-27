# 0117 R2 — MicroPython gets a search path and a stdlib

Branch `0117-r2`. R1 (2026-07-27) turned the vendored MicroPython from a REPL
toy into a script runner. R2 is the other half: a `sys.path` policy and a
curated module set. What follows is the *why*, not the changelog — the ticket
and `vendor/micropython/README.md` carry that.

## The record had to be fixed before any code

Two things a later reader would have used to decide R2's fate were wrong, and
both were wrong in the direction of "cancel this work".

**The park condition never fired.** R2 was parked pending the `todos/0313` M0
probe — "is a real CPython `/bin/python` buildable with our compiler?" M0
answered *yes*, and M1-clang then went and built one. Read literally, that
resolves the condition in the direction that KEEPS the park, and `todos/0313`
still says "R2: KEEP PARKED" in so many words. R2 un-parks anyway, but on a
different premise: the park's logic was "a shipped CPython makes MicroPython
breadth redundant", and redundancy only exists if exactly one implementation
may own the name `python`. jku replaced that model with a dispatcher
(`todos/COMMAND-ALTERNATIVES.md`, `todos/0338`) — implementations coexist by
design now, and he said he "wants all implementations eventually caught up".

The un-park block in the ticket therefore says *in as many words* that the M0
condition did not fire. Without that sentence the next reader notices the
un-fired condition, concludes R2 was un-parked in error, and cancels it on an
argument that looks sound.

**The audience claim was false.** An earlier framing said "the base-image
`python` is MicroPython, so R2's breadth is the default experience". gucOS
ships **no `python` verb at all** in the base image and does not bake
MicroPython into it — it is a gucman package, like `lua` and `sqlite`. The
honest form is "gucOS's python for users who have installed it", which is a
materially smaller claim. Both corrections are in the ticket.

Separately: the `python` alias is now recorded as **INTERIM**, superseding
decider verdict D6's "ratified-deliberate". Dropping it from
`packages/micropython.json` is release-atomic with `todos/0338` landing, so it
was deliberately NOT done here.

## The plan's own premise about the module set was wrong

The R2 plan said the minimal port already shipped
`math`/`sys`/`gc`/`array`/`collections`/`struct`/`errno`. Measured, before
touching anything:

```
missing: gc, array, collections, struct, errno, micropython, json, os,
         time, re, binascii, random, heapq, platform, cmath
```

The real built-in set was `math`, `io`, `sys`, `builtins`. Four of the
"already shipped" modules were part of R2's work. `py/modstruct.c`,
`modarray.c`, `modcollections.c`, `modgc.c` and `moderrno.c` were all listed
in `bin.json` and all compiling to *empty translation units*, because
`MICROPY_CONFIG_ROM_LEVEL_MINIMUM` gates them at CORE/EXTRA. They cost one
`#define` each.

There is a second trap in the same measurement worth writing down: the probe
reported `import os` as **succeeding**, which is how the gap nearly went
unnoticed. It succeeded because the probe ran from the repo root, which
contains a directory called `os/` — FS import found it as a namespace package.
A gap check that runs in a directory shaped like the thing it is checking for
will lie to you.

## `os` without a VFS

Upstream reaches the filesystem only through `MICROPY_VFS`: `listdir`, `stat`,
`mkdir`, `remove`, `rename`, `getcwd`, `chdir` are all `os` re-exports of VFS
functions, every one behind `#if MICROPY_VFS` in `extmod/modos.c`'s globals
table. This port deliberately has no VFS — the kernel owns mounting, and a
second mount table underneath it would be two filesystems disagreeing about
the same paths. R1 hit exactly this wall for *file objects* and resolved it by
lifting upstream's POSIX file object out of the VFS into `file.c`.

R2 applies the same decision to directories, but keeps the patch to ONE hunk:
`extmod/modos.c` is vendored verbatim except for a `#if MICROPY_PY_OS_POSIX_FS`
block in its globals table, and the bodies live in `portmodos.c` — which is not
a new mechanism either, it is upstream's own `MICROPY_PY_OS_INCLUDEFILE`
extension point. `uname`/`urandom`/`getenv`/`system`/`errno` stay upstream's.

`os.path` is the one piece with no upstream counterpart. It is a *real*
submodule (`MICROPY_MODULE_BUILTIN_SUBPACKAGES`), so `import os.path` and
`from os.path import join` both work rather than only attribute access.

## `sys.path`: two decisions worth defending

```
[<script's dir> | ""] , ".frozen" , /usr/local/lib/micropython , <dir of the real binary>/lib
```

**Why `/usr/local`, not `/usr/lib/micropython`.** The ticket suggested
`/usr/lib/micropython`. That would be permanently empty: `/usr` is a sealed,
read-only volume (`todos/0040`), so nothing can ever be installed there at
runtime. `/usr/local` is the OS's writable admin territory (a baked symlink to
`/var/local`) — the same reason `PATH` is `/usr/local/bin:/bin`. The site dir
is the exact analogue of `/usr/local/bin`.

**Why the writable site dir precedes the package's own lib.** CPython orders
stdlib before site-packages, so this diverges. It agrees instead with every
other layered lookup in gucOS — PATH, `/etc/menu` over `/usr/share/menu`, the
`os/cfgstore.h` overlay — where the writable layer wins. A user asking "where
do I put my module, and what happens if it clashes" reaches for the PATH
analogy long before the CPython one.

**The package lib dir is derived, not hardcoded.** micropython is a gucman
package: `/opt/micropython` when installed, `/usr/opt/micropython` on a
`--packages=all` bake, reached through a `/usr/local/bin` or `/usr/bin`
symlink either way. So `main.c` chases argv[0]'s trailing symlinks — the same
trick, for the same reason, as `user32.c`'s `res_chase` finding an app's
`.res` sidecar. The e2e test spawns through the symlink, not the payload,
precisely so a broken chase cannot pass.

Entries are added even when the directory does not exist. `python -c 'import
sys; print(sys.path)'` is how a user learns where to put a module; a path that
omits the answer to save a failed stat is a worse artifact than one with a
dead entry in it.

## Two bugs found by the work, in other people's code

**`mp_hal_ticks_ms()` was `return 0`.** A stub, harmless for as long as nothing
called it — and nothing did, because `time` was not compiled in. Enabling
`time` made every tick function load-bearing at once. A stubbed clock is worse
than an absent module: `ticks_diff` returns 0 forever and a script waiting on
elapsed time hangs *silently*, which is the exact failure shape CLAUDE.md's
test-sync discipline is about. Real clocks now live in `mphal.c` —
`CLOCK_MONOTONIC` for ticks (a REALTIME-backed tick lets a clock adjustment
make an elapsed interval come out negative), `CLOCK_REALTIME` for `time()`.
`mp_hal_delay_ms` is chunked at 50 ms so a cooperative signal is claimed
*during* a long `time.sleep`, not after it.

**`tools/mkmpgenhdr.js` silently dropped an includefile's qstrs.** Upstream's
`makeqstrdefs.py split` names each per-file bucket after the path in the
preprocessor's line markers, `/` → `__`. A file reached through `-I.` is marked
`"./portmodos.c"`, so its bucket lands as `.__portmodos.c.qstr` — a **dotfile**
— and the collecting step's `glob.glob(dir + "/*." + mode)` does not match
leading dots. No error, no warning; just an undeclared `MP_QSTR_splitext` at
link time, with nothing pointing at the cause. This bites exactly the
`MICROPY_PY_*_INCLUDEFILE` files, i.e. upstream's own sanctioned way for a port
to extend a module. mkmpgenhdr un-dots the buckets before the collect.

A cousin of that class, caught by a test rather than the compiler: writing
`MP_QSTR__dot_` for `"."` compiles fine and interns the literal identifier
`"_dot_"`, so `os.path.normpath("")` returned the five-character string
`_dot_`. The qstr pool only carries the escaped spellings it has been told
about — `py/qstrdefs.h` has `Q(/)`, which is why `os.sep` can be
`MP_QSTR__slash_`, but there is no `Q(.)`. `.` and `..` are ROM string objects
now.

## What was deliberately not taken

`hashlib`, `deflate`, `select`, `socket`, `datetime`, `argparse`,
`subprocess`. These are not free the way R2's set was: `hashlib`/`deflate` each
pull a *new third-party library* into `lib/`, which is a supply-chain addition
with its own provenance bookkeeping rather than a config flip;
`datetime`/`argparse` want the micropython-lib vendoring question answered
first; `subprocess` wants a shim over `__spawn`.

`select` is the interesting one. It needs `MP_STREAM_POLL` wired through
`file.c` to the kernel's `FS_SELECT`/`FS_WAIT`, and a `select` that does *not*
compose with the kernel's unified WAIT (`todos/0178`) would be a busy-poll
wearing a `select` costume — worth its own slice rather than a bolt-on.

Two things were dropped for a stronger reason than cost. `os.statvfs` is absent
because the libc's `statvfs` reports a fixed nominal 4 GiB volume (register
entry L15): exposing it would hand Python a number that looks like free space
and is not. `os.sync()` is absent because upstream's body only syncs FatFS
volumes, so with no VFS it is an unconditional no-op — a function that promises
durability it does not deliver. Durability here is the file object's `.flush()`,
a real kernel `FS_FSYNC`. In both cases a missing API is better than a lying
one, and the same reasoning made `os.urandom` *raise* when `/dev/urandom` is
unavailable rather than fall back to a time-seeded PRNG: every caller of
`urandom` is asking for precisely the property the fallback would not have.

All of it is enrolled — register entries **L42** (localtime is gmtime; there is
no timezone database, so local timestamps are UTC) and **L43** (the absent
modules), both funded by `todos/0117` R3. **L35/L36/L37 retired.**

## The shebang story needed no code — but it needed a test

The ticket asked to "consider a shebang story". It turns out `#!/usr/local/bin/
python foo.py` already works through `todos/0065`'s `_spawnShebang`: the kernel
re-dispatches to the interpreter with the script path as argv[1], which is
exactly the CLI R1 built.

Asserting that in the ticket without checking would have been the mistake. The
e2e now spawns a `#!` script as its own command from an unrelated cwd — which
immediately failed, on a *harness* limitation (`loadImage` served only the wasm
map, so the kernel could not read the script's bytes to see the `#!`). Product
fine, test wrong; but "I asserted it works" and "I ran it" were one commit
apart and only one of them was true.

It matters for `todos/0338`: the shebang names `/usr/local/bin/python`, which
is the path the dispatcher will own, so these scripts get
implementation-switching for free once it lands.

## Numbers

- Upstream corpus: **537 → 580 passing**, 3 failed, 108 → 65 skipped. The 3
  failures are the same pre-existing float tests *by name*
  (`builtin_float_round`, `math_domain`, `math_fun_int`), confirmed by
  re-running the suite on a stashed tree.
- `tests/kernel/test_micropython_stdlib_e2e.js`: 52 checks.
- `tests/micropython/09_stdlib.py`: golden generated by real CPython 3 and
  matched byte for byte. One line is an inequality rather than a golden on
  purpose — `cmath.sqrt(-1)` prints `1j` in CPython and
  `(6.123233995736766e-17+1j)` here (polar-form root), so the test asserts the
  mathematical fact instead of pinning either spelling.
- No `os/image.json` change and no image-version bump: micropython is a
  package, so the base image is untouched. `packages/micropython.json` goes to
  `1.28-3`; a `dist/packages` rebuild and a fat-image rebake are what the
  vendor change forces.
