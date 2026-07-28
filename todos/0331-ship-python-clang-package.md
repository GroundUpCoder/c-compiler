# 0331 — Ship python-clang as a gucman package (needs a CPython vendor tree)

> **2026-07-28 (todos/0374):** the package this ticket shipped was RENAMED
> `python-clang` → **`cpython-clang`** (jku ruling, clean break — no alias).
> Occurrences of the old name below are the dated record of what shipped and
> are left as written. Current files: `packages/cpython-clang.json`,
> `tests/kernel/test_cpython_clang_e2e.js`. NB this rename settles the
> PACKAGE name only — the §6.2-vs-uid-657 key-reservation question this
> ticket still owes remains open and is NOT settled by 0374.

- **Status**: open — the blocker is GONE (`todos/0340` landed 2026-07-28 with
  the vendor tree, the sibling manifest project, `packages/python-clang.json`
  (renamed `cpython-clang.json` by 0374)
  and `tests/kernel/test_python_clang_e2e.js` (now `test_cpython_clang_e2e.js`).
  **Every acceptance bullet below
  is already measured green in-OS** by that test; what remains for this ticket
  is whatever shipping work master judges outstanding (the deploy leg, and the
  `commands` claim once `todos/0338` carries it). Historical framing follows.
  Superseded detail: the plan's step 4 says "extend test_clang_pkgs_e2e.js" —
  0340 wrote a dedicated file instead, because a 4.6 MB package with a
  42-leg acceptance surface does not belong bolted onto the C++ ladder test.
  Original status: **blocked on `todos/0340`** (the vendor tree — M1-clang,
  now FUNDED and designed: `todos/CPYTHON.md` is normative for the stdlib
  rule, extension set, layout and package shape; the "M1 unfunded" framing
  below is historical). 2026-07-28: the naming line "python3/cpython …
  must not be claimed here" is superseded by CPYTHON.md §6.2's pending
  cmdalt-keys recommendation (a 0338-lane coordination item) — bare `python`
  stays off-limits either way.
- **Design**: `logs/2026-07-27/python-clang.md`, `todos/CPYTHON.md`

## Goal

jku's ask, verbatim:

> "Can we also ship a python-clang, ie a gucman entry that installs the CPython
> built with clang instead of our own compiler? I'm curious how it'll compare in
> performance with not just my compiler but also against eg micropython with
> either compiler."

The **binary half is done**: `logs/2026-07-27/python-clang-build.sh` builds a
working `python-clang.wasm` (4,529,136 bytes) from CPython 3.13.5 via the sibling
`cc2wasm` toolchain, over the identical 174-TU source list, generated headers and
libc lineage that `compiler.js` uses — so the only variable between the two
artifacts is the compiler. It runs on `host.js` at functional parity (numbers,
`json`, comprehensions, generators, bignums, script-file mode with `sys.argv`).

What is NOT done is shipping it, and the blocker is **not** on the clang side.

## The mechanism (settled — do not re-litigate)

`python-clang` is a **gucman package**, not a bake-overlay entry. Evidence:

- Every existing clang artifact is *both*, in a two-layer pipeline: the sibling's
  `wasm/image/manifest.json` → `mk-overlay.mjs` → `out-image/overlay.json`, which
  is then consumed by (a) the opt-in bake overlay (`os/image.json:3-10`,
  `enableFlag: "clang-apps"`, `default: false`) **and** (b) `mkpkg --clang` via
  the `clangApp` resource kind (`tools/mkpkg.js:316-323`).
- The user-facing half — what "a gucman entry that installs …" means — is (b):
  `packages/box2d-clang.json` is the exact template (`"requires":
  "clang-sibling"`, `"files": {"box2d-clang": {"clangApp": "box2d-clang"}}`,
  `"bin": {"box2d-clang": "box2d-clang"}`). Seven such packages already ship.
- **Verb**: `python-clang` only. gucman has **no** alternatives/provides/conflicts
  mechanism (`grep -E 'conflict|provides|replaces|alternativ'` over `gucman.c` +
  `mkpkg.js` → zero hits), and `gucman.c:976-980` refuses the whole install on an
  existing `/usr/local/bin` symlink. `python3`/`cpython` are reserved for the real
  CPython package and bare `python` belongs to micropython
  (`packages/micropython.json:8`), so those must not be claimed here.

## Why it is blocked

Two hard dependencies, both on a **committed CPython source tree** that neither
repo has:

1. **Payload channel.** `clangApp` can only name a payload that already exists in
   the sibling's `out-image/overlay.json`. Publishing one means adding a project
   to the sibling's manifest, and every project needs a committed `base` + source
   list. The build currently runs out of a machine-local `~/build/python-clang`;
   pointing a committed manifest at that path would produce an artifact nobody
   else can rebuild.
2. **The stdlib.** The binary is useless alone — verified: with no
   `PYTHONHOME`/`PYTHONPATH` it dies with `ModuleNotFoundError: No module named
   'encodings'` (`encodings` is not in the 24 frozen modules). A usable package
   must carry a stdlib tree: **538 `.py` files / ~10 MB** excluding
   `test`/`idlelib`/`tkinter`/`turtledemo`. That is well within gucman package
   norms — but *which* modules ship, how they are laid out, and how `PYTHONHOME`
   is wired is the CPython-port design, i.e. **M1's** call.

⚠️ **Do not resolve these by vendoring CPython from this ticket.** M1 is unfunded
and unratified (`todos/0313`: "M1 is unfunded, and the route is a decider call jku
has not ratified"), and jku has already ruled on adjacent points (CPython ships
as a gucman package, never baked; it claims `python3`/`cpython` only). A
`python-clang` lane inventing its own `vendor/cpython` layout and stdlib subset
would collide head-on with M1's.

## Plan (once a CPython vendor tree exists)

1. Add a `python-clang` project to the sibling's `wasm/image/manifest.json` with
   `base: "$CC_ROOT/vendor/cpython"` + a `bin.json` naming the 174 TUs. Note
   `mk-overlay.mjs`'s `enforceClangConvention` requires a `$CC_ROOT/vendor/`-based
   project to be named `*-clang` and install to a fresh `/usr/bin/*-clang` path —
   `python-clang` → `/usr/bin/python-clang` already satisfies it.
   Carry over the recipe's `-DDATE`/`-DTIME` pinning (below) and the
   `-Wl,-z,stack-size=8388608` that replaces `compiler.js`'s `__minstack`.
2. `node wasm/tools/mk-overlay.mjs` to publish.
3. Add `packages/python-clang.json` here, modelled on `box2d-clang.json`, with
   the stdlib carried as a `tree` entry (`mkpkg.js:304-311`) or shared with the
   `cpython` package if M1 provides one to depend on.
   **Not before step 2**: `mkpkg --clang` builds *every* `requires`-gated
   definition, so a `clangApp` naming an absent overlay path turns the whole
   clang-package channel red.
4. Extend `tests/kernel/test_clang_pkgs_e2e.js` with an install → `python-clang
   -c "print(1+1)"` → remove leg.

## Acceptance — all measured 2026-07-28 (todos/0340)

- **PASS** `gucman install python-clang` plants `/usr/local/bin/python-clang`;
  in-OS `print(1+1)` prints `2` and the banner reports
  `3.13.5 (main, xx/xx/xx, xx:xx:xx) [Clang 21.1.8 …]`.
- **PASS** `gucman remove python-clang` leaves no symlink and no `/opt` tree
  (no menu entry is claimed — an interpreter's surfaces are the shell and, once
  `todos/0338` lands, the dispatcher).
- **PASS** bare `python` is not claimed by this package. NB the premise moved:
  a fresh gucOS ships **no python verb at all** (asserted in the e2e's purity
  leg) — micropython is itself an opt-in package. `python3` is now an approved
  cmdalt KEY (master, 2026-07-28), not a hard symlink; `cpython` is rejected as
  a key and stays reserved.
- **PASS** the published payload is byte-reproducible: two full publishes into
  the same output path produced sha256 `7daa8881…`. Payloads embed their build
  path (`todos/0349`), so the comparison is only valid in one directory.

## Reproducibility note carried forward

`getbuildinfo.c` bakes `__DATE__`/`__TIME__`, which `compiler.js` happens not to
define (its banner reads `xx/xx/xx`) but clang does. The recipe pins
`-DDATE='"xx/xx/xx"' -DTIME='"xx:xx:xx"'` — CPython's documented override — so the
payload can satisfy overlay@1's byte-reproducibility contract. Two independent
full builds were verified to differ in **exactly one field**: the module name in
the `name` section, which `wasm-ld` bakes from the `-o` basename (mk-overlay
already builds straight to the final name for this reason).
