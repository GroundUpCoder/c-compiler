# 0340 — vendor CPython 3.13.5 + stdlib tree + the expanded python-clang binary (M1-clang execution)

- **Status**: open
- **Difficulty**: medium (the design is done and probe-verified; this is
  mechanical execution of `todos/CPYTHON.md` — read it FIRST, it is
  normative; probe reproduction in `logs/2026-07-28/m1-clang-stdlib-design.md`)
- **Provenance**: jku lean 2026-07-27 ("python-clang as the preferred python
  … highest chance of being able to support pygame"), funded by decider call
  (meta note `fable-decider-python-primary-2026-07-27.md` §jku LEAN).
  Sequencing note: `todos/0330` (sibling libc re-vendor) should land first or
  with this — the ELOOP/termios libc fixes only reach cc2wasm through it

  🔴 **HARDENED 2026-07-28: this is now `blockedBy` 0330, not `after`.** `after`
  is advisory and does **not** gate readiness, so this item was showing **ready
  at rank 3** while 0330 sat unmerged — a lane spawned here would have built
  against the **stale** libc extraction. That is a silent wrong baseline, not a
  build failure, which is exactly the kind of gap `after` is too weak to hold.
  The "or with this" path is retired: 0330 is **delivered and pushed in BOTH
  repos** (c-compiler `ad68a6d4`, clang-simplified `85aa87b9`) and needs only a
  merge, so carrying it inside this ticket buys nothing. **Merge 0330 in both
  repos and move `todos/0330` to `done/` before starting.**

  ⚠️ Same reason applies to `mkpkg --clang`: it verifies payloads against
  `../clang-simplified/out-image/overlay.json`, generated from the sibling's
  **checked-out** tree. While that sibling's `main` is still `1beacf2`, any
  clang package rebuild also uses the stale libc.
  (queue carries the soft dep).

## Work list (detail and rationale live in CPYTHON.md — do not re-decide here)

1. **`vendor/cpython/`** per CPYTHON.md §4: pruned 3.13.5 sources for the
   §3.2 TU list (+ `Modules/expat`, `_hacl`, `_blake2`), `Lib/` per the §2
   exclusion rule, `gen/` (pyconfig.h + config.c with the 26-extension
   inittab + 24 frozen_modules + shim), `srcs.txt`, `bin.json`, README with
   the §4.2 patch table (expat `#undef PREFIX`, fcntl ioctl cast,
   subprocess.py posix_spawn guard, pyconfig edits — nothing else).
2. **libc**: `#define ELOOP 40` (+ strerror) in compiler.js errno.h — the
   kernel already raises 40 (`host.js:10687`); the termios surface + the
   variadic-`ioctl` question are `todos/0325` Group D (do there, or here
   with 0325 cross-off). Conformance tests per libc convention.
3. **Extensions beyond the probe set**: `fcntl` + `termios` (post-libc),
   `zlib` against `vendor/zlib` (drops the binascii caveat, revives `gzip`
   and zipfile-deflate). `_sqlite3`/`_decimal` only if their measured deltas
   say so (§3.3 Tier 2).
4. **Sibling manifest project** (`python-clang`, `base:
   "$CC_ROOT/vendor/cpython"`) + `packages/python-clang.json` per §6.1 in the
   same window (the 0337 drift gate fails the build otherwise, by design) —
   this closes into `todos/0331`'s acceptance (banner, install/remove e2e,
   byte-reproducibility).
5. **`_sysconfigdata__gucos_.py`** + `MACHDEP "gucos"` (§5.4); launcher
   wrapper with `PYTHONPYCACHEPREFIX=/var/cache/python-clang` (§5.3).
6. **Acceptance beyond 0331's**: the import sweep ≥154/183 (project ~166
   with the step-3 items) recorded in the test, symlinked-argv0 landmark
   discovery **in-OS**, `subprocess.run(["ls"])` over posix_spawn in-OS,
   `python-clang foo.py` with argv + exit status.
7. **Coordination (master)**: §6.2 `python3`/`cpython`-as-cmdalt-keys
   recommendation → 0338 lane; MicroPython-package `commands` parity.

## Non-goals here

pygame/SDL (M2/M3 — §8 carries the priced SDL2-vs-SDL3 flag), `_socket`/
`_ssl` (§3.3: OUT until real networking; asyncio honesty note travels with
every user-facing description), zip-stdlib (deferred lever, §2).
