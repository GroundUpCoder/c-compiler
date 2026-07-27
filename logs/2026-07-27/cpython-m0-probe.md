# todos/0313 — M0 probe: can our compiler build CPython core?

**Verdict: YES-BUT.** CPython 3.13.5 compiles with `compiler.js` and the
resulting wasm module runs `python -c "print(1+1)"` → `2`. Getting there needed
**three compiler fixes** (all reduced to minimal repros and filed), one
strictness relaxation, and a list of missing libc surface. **Nothing was
classified "genuinely infeasible."**

Provenance note, kept accurate deliberately: the *goal* (unmodified pygame games
on gucOS) is **jku's ask**. The *route* (real CPython rather than a MicroPython
C-API shim) is a **decider call** from Fable design pass A, routed to jku and not
objected to — **not approved**. Nothing below rests on authority; every claim is
a measurement or a citation.

**Nothing was vendored. No `bin.json` entry. No `os/image.json` bump.** All work
in `/tmp/cpy-m0`, per the ticket's throwaway-by-design instruction.

## Step 1 — the three settled premises, verified against upstream

The ticket took three things as given. All three hold, verified against the
CPython 3.13.5 source rather than docs:

| claim | evidence |
|---|---|
| wasm32-wasi is a tier-2 platform | `configure.ac:1184` `[wasm32-unknown-wasip1/clang], [PY_SUPPORT_TIER=2]`; `Doc/whatsnew/3.13.rst:177` |
| single-threaded via pthread **stubs** | `configure.ac:4586` `[WASI], [posix_threads=stub]` → `HAVE_PTHREAD_STUBS`; `Include/cpython/pthread_stubs.h` ("pthread_create() fails"), `Python/thread_pthread_stubs.h` |
| no-dlopen static extensions via `Modules/Setup` | `configure.ac:1300` — `--enable-wasm-dynamic-linking` on WASI is a hard `AC_MSG_ERROR([WASI dynamic linking is not implemented yet.])`; `DYNLOADFILE` falls to `dynload_stub.o` when `dlopen` is absent; `Modules/Setup{,.bootstrap.in,.stdlib.in}` is the mechanism |

No premise moved, so the probe proceeded.

## Step 2 — a positive control first

Before judging our compiler, I established that CPython→wasm32 is achievable at
all, so any failure would be attributable. Built CPython 3.13.5 with
**wasi-sdk 25** for `wasm32-unknown-wasip1`: **`python.wasm`, 29 MB, links
clean.** Compile stage had **zero errors across 304 objects** (every `error:` in
the log was `wasm-ld`).

Two warts worth recording, both environmental rather than upstream bugs:

- `$(AR) $(ARFLAGS)` produced 96-byte empty archives on a macOS host; forcing
  `AR=llvm-ar` and deleting the stale `.a`s fixed it.
- wasi-sdk 25 declares `memfd_create` without implementing it, so
  `ac_cv_func_memfd_create=no` is needed (CPython CI uses wasi-sdk 22/24).

This build also produced the artifacts our compiler needs and cannot generate:
`Python/frozen_modules/*.h` (24), the authentic WASI `pyconfig.h` as a base, and
`Modules/config.c`.

## Step 3 — front-end sweep, 269 → 205 → 200 TUs

Drove `compiler.js -a parse` over every core TU independently. Per-TU, so one
bad file cannot mask the other 268. The AST dump length was the positive control
that the toolchain really processed each source rather than silently no-opping.

| pass | result | what changed |
|---|---|---|
| 1 | **210/269** | first contact |
| 2 | **187/205** | patched compiler + port `pyconfig.h`; excluded 64 CPython **test-only** TUs which `#error` under `Py_BUILD_CORE` (harness artifact, not a finding) |
| 3 | **200/205** | remaining `HAVE_*` knobs + libc shims |

The five that never got through the front end: `Modules/socketmodule.c`
(three missing `netinet/*`, `arpa/inet.h` headers) and four **empty** TUs.

An honest note on the failure counts: the first-pass "59 failures" was not 59
findings. 28 were my own harness passing `-DPy_BUILD_CORE` to modules that
require it absent, and most of the rest collapsed into single root causes
(one missing `memrchr` produces four "cannot convert 'int' to '\*const char'"
errors downstream). The classification is the deliverable; the count is not.

## Step 4 — whole-program link and codegen

Link went **419 → 173 → 2 → 0** errors. Then codegen: **7 MB wasm, exit 0,
23 seconds** for 173 TUs. Then, with `__minstack(8388608)` (CPython's WASI build
uses `max-wasm-stack=8388608`) and `PYTHONHOME` pointed at `Lib/`:

```
$ node host.js python.wasm -c "print(1+1)"
2
$ node host.js python.wasm -c "import sys; print(sys.version)"
3.13.5 (main, xx/xx/xx, xx:xx:xx) [C]
```

Re-verified against a **pristine, un-instrumented** CPython tree after all
debugging edits were reverted.

Also working: list comprehensions, dict comprehensions, `sorted()`, `2**100`
(so the 30-bit-digit bignum path is fine without `__int128`).

## The punch-list, classified

### Compiler defects — 3, each reduced to a minimal repro, each filed

**`todos/0319` (P0) — compound literal in a local declaration's initializer
clobbers the caller's stack frame.** The one that mattered. A struct-typed
compound literal in an initializer position is missed by the frame-layout walk,
so `compoundLiteralOffsets.get(cl)` is `undefined`, `emitFrameAddr` computes
`savedSp + NaN` → 0, and the literal is written **into the caller's frame**.
25-line repro; clang clean. Only the initializer position is affected —
assignment, address-of, static-target and member-access-base positions are all
fine, which is why it survived: in-tree C writes the named-temp form.

**`todos/0320` (P0) — preprocessor blows the JS stack at ~70k tokens.**
`expanded.push(...expandedResult)` — spread, not recursion; V8's argument limit.
Eight sites in the preprocessor. Kills `Python/pylifecycle.c` and
`Python/pystate.c` (`_PyRuntimeState_INIT`).

**`todos/0321` (P0) — a `static` function re-declared *after* its definition
becomes an undefined symbol.** 168 of 173 remaining link errors. The
`todos/0219` guard at `compiler.js:13368` already handles
`static def; extern decl;` but is gated on the redeclaration being *non*-static
— and Argument Clinic emits `static` redeclarations, with the clinic header
`#include`d at the **bottom** of each `.c`.

Plus two non-defect compiler items:

- **`todos/0323` (P1, confirmed by @master)** — whole-program link rejects
  cross-TU declared-type mismatches. CPython relies on this deliberately via
  `PY_CXX_CONST`. Technically UB (C11 6.2.7p2); accepted by clang/gcc/MSVC.
  I filed it P1 with the priority flagged as a judgement call; @master confirmed
  P1 — the mismatch is a `const` qualifier with no ABI consequence and is an
  artifact of our whole-program model, not wrong code, and P0 here means silent
  wrong code in a shipped feature (that is 0319). It becomes a **hard
  prerequisite** the moment an M1 CPython port is funded.
- **`todos/0322` (P1)** — empty translation unit rejected. Verified with a
  positive control that clang emits genuinely empty objects for the same four
  CPython Tier-2 files (0 defined symbols vs 176 for `ceval.o`).

### Missing libc surface — `todos/0325`

Four groups, the important distinction being whether a port can configure around
the absence. **Group A has no escape**: `fma`, `gmtime_r`, `clock_getres`,
`wcstol`, `isascii`, `tzset`, and `clockid_t`/`struct timespec` not being visible
through `<sys/types.h>`. Group B is ~25 `HAVE_*`-gated entries each of which
silently costs a Python feature (the whole `*at()` family = `os.*` dir-fd
support). Group C is the absent headers — `netinet/*` is exactly the cost of
`import socket`.

Separately **`todos/0324`**: C11 `<stdatomic.h>` / `__atomic_*`. This is the very
first wall — every CPython TU fails at header-parse until it is worked around,
because `pyatomic.h` has no fourth branch. Cheap for us specifically: gucOS
processes are single-threaded and CPython's own WASI config is too, so plain
load/store is sound.

### Genuinely infeasible — **none**

No failure in the whole sweep classified this way.

## The folded-in numpy probe

Answered, at compile-stage confidence. **I did not link or run numpy** — say so
plainly.

Built numpy 2.2.6 natively to generate its templated sources (it needs its own
**forked Meson**, `vendored-meson/meson/meson.py` — stock meson lacks the
`features` module), then cross-configured for `wasm32` and drove `compiler.js`
over the resulting `compile_commands.json`.

The first run said 0/151. That was **my harness**, not numpy: `compile_commands`
paths are build-dir-relative. Worth recording as the exact trap the ticket warned
about — a failure count is not a finding.

Real progression:

| state | TUs parsing |
|---|---|
| wasm32 config, no patches | 5/164 |
| + extend numpy's struct-complex path (`__cplusplus` → `\|\| __STDC_NO_COMPLEX__`), 1 site | 75/164 |
| + the same at `npy_math.h`'s 6 accessor guards | **83/164** |

Of the remaining 81: **33 are my harness's missing generated headers**
(`templ_common.h`, `arraytypes.h`, `npy_sort.h`, `funcs.inc` — numpy's `.src`
generator did not run for every target because the wasm32 ninja build stopped
early on a CPython-header `LONG_BIT` mismatch), 46 are the Group D libc list
(long-double libm, `isgreater`/`isless`, `__builtin_*`, xlocale), 1 is the
empty-TU defect, and 1 is a genuine small numpy portability gap
(`dragon4.c:3123` passes `long double *` where `double *` is expected — only
bites where `long double == double`).

**The headline finding: implementing C99 `_Complex` is NOT a prerequisite for
numpy.** numpy 2.x already carries a struct-complex path with
`npy_creal`/`npy_cimag`/`npy_csetreal` accessors for C++/MSVC; it is gated on
`__cplusplus` alone. Seven guard sites took the sweep from 5 to 83 TUs with
**zero compiler changes**. So numpy is bounded port work, not a wall — though a
proper `_Complex` remains the cleaner of the two routes.

Prior art supporting feasibility: numpy ships an official Emscripten cross-file
(`tools/ci/emscripten/emscripten.meson.cross`) and is shipped by Pyodide, so
numpy-on-wasm32 is a maintained configuration upstream.

## The abandon trigger — stated up front, not fired

The trigger was: punch-list growing faster than it shrinks at the 2-week mark, or
any single failure classified "genuinely infeasible AND load-bearing."

**Neither fired, and the shape is the opposite of the trigger.** The list shrank
monotonically and fast — 269→205→200 TUs on the front end, 419→173→2→0 link
errors — and it converged inside one day, not two weeks. Every wall had a
bottom: the largest single cluster (168 link errors) was one condition in one
`if`. Nothing was classified infeasible.

## Recommendation on `todos/0117` R2 — **KEEP PARKED**

**Reason, recorded beside the verdict so a later reader can tell a fired
condition from an open one:** R2 was parked on exactly one question — whether a
real CPython `/bin/python` is buildable, because it would supersede MicroPython
stdlib breadth. **M0 answers yes.** CPython 3.13.5 compiles with our compiler and
runs Python. The condition R2 was waiting on has resolved in the direction that
keeps it parked.

Two honest caveats on that recommendation:

1. This is a *throwaway* build. M1 (a real `/bin/python`: vendored, `bin.json`,
   baked, in-OS) is unfunded and is where the size question lands — ~7 MB wasm
   for a **minimal** interpreter, before the stdlib, so this is gucman-package
   territory, not the `/usr` blob.
2. The route itself is a decider call jku has not ratified. If he overturns it,
   R2 un-parks immediately and this recommendation is void.

`todos/0117` **R1 is unaffected** and should stay foregrounded: it is
independently useful, explicitly asked for, and is the fallback if the arc
stalls at M1.

## Gotchas worth keeping

- **Whole-program compilation has no per-TU macro namespace.** CPython's build
  passes `-DPREFIX=...` to `getpath.c` only; passing it globally broke
  `Modules/expat/xmlparse.c`, which has a `typedef struct prefix { … } PREFIX;`.
  Any port of a codebase with per-file `-D` needs a story for this.
- **`__minstack(N)` is source-level only** — no CLI flag. A port of third-party
  code can only set the stack size by editing vendored source or adding a file
  of its own. CPython needs 8 MB.
- **`-D__USE_SYSTEM_ENDIAN_H__`** makes CPython's `_hacl` take our `<endian.h>`
  instead of a fallback that needs statement expressions and `__extension__` —
  reclassifying that whole cluster from "compiler gap" to "one flag."
- **When a lookup can return `undefined`, make the consumer fail loud.** Hours of
  runtime bisection on 0319 collapsed the moment a one-line
  `Number.isFinite` guard went into `emitFrameAddr`. The silent `NaN`→0
  degradation *was* the bug's disguise.
