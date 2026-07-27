# 0330 — Re-vendor clang-simplified's wasm/libc (206 commits stale; blocks CPython)

- **Status**: open
- **Design**: `logs/2026-07-27/python-clang.md` §"The libc is 206 commits stale"

## Goal

The sibling `clang-simplified` repo builds every `*-clang` artifact against a
**mechanical extraction of this repo's own libc** (`wasm/tools/extract-libc.js`
pulls `_stdlibHeaders`/`_stdlibSources` straight out of `compiler.js`). That
extraction is pinned:

    ~/git/clang-simplified/wasm/libc/_provenance.json
      { "vendoredFromRepo": "c-compiler",
        "vendoredFromCommit": "2b6bfb7a79c7988bc922e43792b3fc96a0124d01" }

`2b6bfb7a` is **206 commits** behind this repo's `3d51b684`. Re-extracting from
current HEAD changes **10 files**:

    SDL.h  __SDL.c  __setjmp.c  __string.c  errno.h  setjmp.h  unistd.h
    + new: SDL3/  SDL3_image/  __SDL_image.c

That staleness is not cosmetic — it **blocked the python-clang build**:
`unistd.h` predates `pread`/`pwrite` (added here in `1794b618`, NetSurf Lane 1),
and CPython's generated `pyconfig.h` sets `HAVE_PREAD 1`/`HAVE_PWRITE 1`, so
`Modules/posixmodule.c` failed to compile under clang while compiling fine under
`compiler.js`. The python-clang lane worked around it with a build-local
`-include` shim (`logs/2026-07-27/python-clang-shim.h`) that copies the two
functions **verbatim** from `compiler.js`'s `unistd.h`; that shim should be
deleted when this lands.

`errno.h` is also missing `EILSEQ` on the pinned side (no consumer hit it yet).

**Why this matters beyond one build**: the drift is a silent, growing skew
between the two toolchains. Any A/B measurement across them — which is exactly
what `python-clang` exists for — is measuring "clang vs compiler.js" *plus* "libc
2026-07 vs libc 2026-05". The longer the pin sits, the more of the second term
leaks into the first.

## Plan

1. In the sibling: `node wasm/tools/extract-libc.js ~/git/c-compiler/compiler.js
   wasm/libc`, then `./wasm/tools/check-libc-vendor.sh` (the todos/0039 invariant
   guard) must pass — committed == regen, byte for byte.
2. Re-publish: `node wasm/tools/mk-overlay.mjs`. **This changes the bytes of all
   9 existing overlay payloads**, so their acceptance legs have to be re-run —
   that blast radius is the reason this is its own ticket rather than a drive-by
   in the python-clang lane.
3. Re-run `node tests/kernel/test_clang_pkgs_e2e.js` on this side (six install +
   launch legs over the republished overlay), plus the sibling's own
   browser-check harnesses for doom/gameboy/imgui.
4. Delete the pread/pwrite half of `logs/2026-07-27/python-clang-shim.h` and
   rebuild python-clang to confirm it is no longer needed.

## Acceptance

- `check-libc-vendor.sh` exits 0 against current `c-compiler` HEAD.
- `_provenance.json` records a commit at-or-after `1794b618`.
- `test_clang_pkgs_e2e.js` green on the republished overlay.
- The python-clang build (`logs/2026-07-27/python-clang-build.sh`) compiles
  `Modules/posixmodule.c` with the shim's `pread`/`pwrite` block removed.

## Note — a second, independent instance of the same gap

`wcstol` is missing from `compiler.js`'s libc entirely (`todos/0325` Group A
lists it). **Both** downstream projects discovered and filled that hole on their
own: the CPython probe in `ccprobe_libc.c`, and the sibling as
`wasm/libc-ext/__wcsto.c`. They collided at link time in the python-clang build
(`duplicate symbol: wcstol`). Fixing `0325` Group A upstream retires both copies;
until then the python-clang recipe renames the shim's copy so the *same*
implementation is in force on both sides of the A/B.
