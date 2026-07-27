# 0340 — vendor CPython 3.13.5 + stdlib tree + the expanded python-clang binary (M1-clang execution)

- **Status**: DONE 2026-07-28 (branch `0340-cpython`; sibling `clang-simplified` branch `0340-cpython`)
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


## Outcome (2026-07-28)

Every work-list item landed. Measured, not projected:

- **`vendor/cpython/`**: 3.13.5 pruned by a `clang -M` dependency scan over the
  real build's flags — 649 source files (17.7 MiB) + `Lib/` (549 files,
  9,919,793 B: the 548 the §2 rule selects plus the generated
  `_sysconfigdata__gucos_.py`) + `gen/` (29 files) + `srcs.txt` (249 TUs) +
  `bin.json` + a README carrying the complete patch table.
- **libc**: `ELOOP 40` + its `strerror` line; the `<termios.h>` line-control
  quartet, the `TC*FLUSH`/`TC{OOFF,OON,IOFF,ION}` selectors and the full `B*`
  rate ladder; `ioctl` now reports `ENOTTY` for an unmodelled request instead
  of a bare `-1` over a stale errno. Conformance test
  `tests/unit/conformance/libc_eloop_termios_surface`. This obliges an image
  rebake — **master assigns the version; `os/image.json` is untouched here.**
- **Beyond the probe set**: `fcntl`, `termios`, `zlib` (against `vendor/zlib`),
  and both Tier-2 candidates admitted on measured deltas — `_decimal`
  +258,947 B (+4.2 %) and 8.8× faster than `_pydecimal`; `_sqlite3`
  +1,173,422 B (+19.0 %, +433,365 B gzip) against the already-ported
  `vendor/sqlite`. Table + reasoning in the vendor README §2.
- **Package**: sibling manifest project `python-clang` → `/usr/bin/python-clang`,
  `packages/python-clang.json` (`clangApp` binary + `tree` stdlib + launcher),
  in the same window as the overlay publish so the 0337 drift gate stays green.
  Binary 7,636,885 B; package 4,603,396 B down / 17,557,740 B installed over
  552 files. **Byte-reproducible**: two publishes into the same path, same
  sha256.
- **`_sysconfigdata__gucos_.py`** + `sys.platform == "gucos"` (via `-DPLATFORM`,
  which is the knob `Python/getplatform.c` actually reads — `MACHDEP` is not
  referenced by any TU we build) + the `PYTHONPYCACHEPREFIX=/var/cache/python-clang`
  launcher.
- **Acceptance**: `tests/kernel/test_python_clang_e2e.js`, 42 legs, all PASS
  in-OS. Import sweep **166 of 180** shippable top-level modules, every one of
  the 14 failures a named CPYTHON.md §3.3 casualty (`_socket` ×8, `_bz2`,
  `_lzma`, `_ctypes`, `_curses`, `_ssl`).
- **Names**: master ruled `python3` an approved cmdalt key and `cpython`
  rejected as one; the package declares `commands: {python, python3}`, which is
  INERT until `todos/0338` teaches `packageControl` to carry the section. The
  §6.2 tension — CPYTHON.md reserves the hard claim `cpython` for a future
  our-compiler package while an earlier note had CPython claiming it — is left
  open on purpose and is not this ticket's to settle.

### A P0-class bug found and fixed on the way

The brokered `__readdir` (`host.js`) set `errno = EIO` at **end-of-directory**.
POSIX requires `readdir` to leave errno alone there, because that is the only
way `errno = 0; while ((e = readdir(d))) …; if (errno) error;` can tell EOF from
failure. Under a kernel every directory walk therefore ended in a phantom I/O
error; `os.listdir` is exactly such a caller, so the **entire CPython stdlib was
unimportable in-OS** while working under bare host.js (whose standalone
`__readdir` already got it right). Fixed, with a C-level regression leg in the
e2e. Any in-OS program that walks a directory the POSIX way was affected.
