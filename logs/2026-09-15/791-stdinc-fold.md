# #791 — fontbridge header enters /usr/include through the builtin fold

Branch `integrate/791-stdinc-fix`, based on the independently approved graphics
integration tip d57fa742. Fix only; no runtime, ABI or test-registry change.

## Why

The mapped integration gate on d57fa742 (both the run killed by the Codex cap
on 2026-09-14 and the 2026-09-15 re-run) failed exactly one host file,
`tests/host/test_stdinc_fold.js`:

    FAIL nothing EXTRA is planted (the set is exactly the map)  89 vs 88
    FAIL the input manifest is not mutated

#791 planted `/usr/include/gucos/fontbridge.h` by hand in `os/image.json`
(`files` entry + two `dirs` rows). The #439 invariant is that `/usr/include`
is generated from the compiler's MERGED builtin-header map at the one bake
choke point (`foldStdlibHeaders`), so it cannot drift from what
`#include <...>` resolves. A hand-planted header is exactly the hazard that
guard exists to catch: in-OS `cc` searches `/usr/include` AFTER the builtins,
so a header that lives only in the image is a second, unguarded resolution
path with no bake-time twin.

## Fix

- `compiler.js`: `gucos/fontbridge.h` is a `standardHeaders` entry beside
  `guc.h` (the existing gucOS-specific builtin precedent). It now resolves
  identically for the bake-time cc driver, the in-OS `cc`, and the host
  tests, and the fold plants it at `/usr/include/gucos/fontbridge.h`.
- `os/image.json`: the hand-planted file entry and the `/usr/include`,
  `/usr/include/gucos` dirs rows are removed; the fold derives the dirs.
  Version stays 293 (candidate, unshipped; live edge is v291).
- `os/fontbridge/fontbridge.h` deleted — one literal, one source of truth.
  README points at `<gucos/fontbridge.h>`.

## Verified locally (non-heavy)

`test_stdinc_fold.js` all ok; `test_fontbridge.js`, `test_sdl_clip.js`,
`test_gcstr_imports.js` pass; `tools/mksdlindex.js --check` in sync; unit
850/0/3; `node compiler.js tests/browser/fixtures/fontbridge.c` compiles the
browser fixture against the builtin. The mapped gate (compiler.js ⇒ all 25
suites) is recorded separately below once it completes.
