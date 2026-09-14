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

## Mapped gate on exact 6a130848 — GREEN (sliced, 2026-09-15)

`node tests/run.js --diff e54f0114 --dry-run` on this tip selects the same 25
suites the coordinator ran on d57fa742 (only `netsurf-patch` omitted). The
run was executed as FOREGROUND SLICES under the tool's 10-minute cap (the
#624 precedent), one heavy suite at a time under the host heavy lock, in the
fix worktree `~/git/c-compiler-791-fix`:

- `todos` 3/3, `unit` 850/0/3, `host` all 69 files (incl.
  `test_stdinc_fold.js`), `blockfs` 15/15 — each dispatcher slice exit 0.
- run.py categories (ast…fakegit, one batched process): 903 passed, 0 failed,
  112 skipped, exit 0.
- `kernel`: 210/210 recorded, 0 failed, across five `--filter` slices
  (`kernel-slices.json`; `test_os_boot.js` solo 712 s; the two
  gucos-packages sibling members last). `test_stdinc_e2e.js` — the boot-level
  twin of the host guard, red on d57fa742 for the same hand-planted header —
  passes.
- `sweep`: 77/77 recorded, 0 failed, across seven `--filter` slices
  (`sweep-slices.json`), including `os-fontbridge.mjs` (the in-OS `cc`
  resolving `<gucos/fontbridge.h>` as a builtin) and `os-renderclip.mjs`.

Records: `791-gate-evidence/kernel-summary.json` (`done: true`,
`files.recorded == files.total == 210`, zero non-pass),
`browser-summary.json` (`done: true`, `77 == 77`, zero non-pass),
`slice-verdicts.txt` (each slice's verdict lines). Because the suites ran as
separate dispatcher invocations there is NO single `build/test-run/summary.json`
covering all 25 — the per-suite merged records above are the evidence, and
`resumed == 0` in both (nothing was `--resume`d; carried rows are this tree's
own earlier slices, never another tree's).

The killed 2026-09-14 gate on d57fa742 and its 2026-09-15 re-run (which died
with the session before the sweep finished) both had exactly two reds, both
this header: `host/test_stdinc_fold.js` and `kernel/test_stdinc_e2e.js`.
Every other row that completed in those runs was green.
