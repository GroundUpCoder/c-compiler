# 0079 — dedup diamond project deps (compiler.js + os-common.js)

## What / why

`expandProjectJson` (compiler.js `main()`) expanded a project's `deps`
recursively with no dedup, so a diamond — A deps zlib AND libpng, libpng
deps zlib — compiled zlib's sources twice and died at link with ~80
"Duplicate definition of symbol" errors (reproduced: 76 on cairo before
the fix). 0061 hit this wiring cairo and worked around it by DEP HYGIENE:
cairo's lib.json deliberately omitted the direct zlib dep it conceptually
has. That put correctness in the manifest author's head instead of the
tool — any future lib.json that honestly listed its deps would explode.

## The fix

- `expandProjectJson` threads a `seen` Set keyed on
  `fs.realpathSync(path.resolve(jsonPath))` — first occurrence wins,
  later ones return `[]`. Realpath keying means a symlinked route to the
  same lib.json also collapses (proven by the fixture's
  `base-link.json -> base.json` leg). The `-I`/compilerArgs a skipped
  occurrence would have contributed are position-independent, so
  dropping them is safe; sources compiling once is the point. The Set is
  created once in `main()` and shared across all CLI json args (two
  project files on one command line link into one module — same rule).
- **Same bug, second expander**: `os/os-common.js buildProject`'s
  depth-first `expand()` had the identical no-dedup hole — a seeded
  project with an honest diamond would have broken the image bake the
  same way. Deduped on the normalized path (no `realpathSync` in the
  kernel-worker XHR context; matches `addProject`'s existing
  `seenProjects` convention in `newestBakeInput`, which already deduped).
  No image version bump: no currently-seeded project has a diamond, so
  bake output is byte-identical.

## Regression proof

- `vendor/cairo/lib.json` gets its honest `../zlib/lib.json` back
  (listed directly AND via libpng) — `node compiler.js
  vendor/cairo/bin.json` links clean, covered continuously by the
  `projects`/`cairo` categories.
- New focused fixture `tests/projects/diamond/`: `base.json` reached
  (1) directly, (2) via `mid.json`'s dep, (3) via the `base-link.json`
  symlink. Pre-fix: 2× "Duplicate definition of symbol 'base_value'"
  (verified by stashing the compiler fix). Runs as
  `projects/diamond-dedup` in run.py — builds AND executes, asserting
  `diamond: 63`. New `tests/projects/` → `projects` rule in
  tests/run.js RULES (the fixture showed up UNMAPPED in `--diff
  --dry-run`, which is the rule-adding signal working as designed).

## Gate

Diff plan (`node tests/run.js --diff`): compiler.js → unit/kernel/blockfs,
os/os-common.js → kernel/sweep, run.py → all py categories, cairo →
cairo/projects. Run in foreground chunks:

- unit + blockfs: green (unit 10s, blockfs 89s incl. fuzz).
- projects/zlib/lua/freetype/libpng/cairo/sqlite: 96 passed, 0 failed,
  7 skipped (169s) — cairo re-links with the diamond, diamond-dedup passes.
- ast/extra/ext/micropython/disw/sourcemap/tcc/libc/fuzz/fakegit:
  170 passed, **9 failed — all `fakegit/*`, pre-existing**: the fakegit
  goldens run against *this repo itself* and pin `HEAD` at `fbc85224`
  (365 commits ago) — the category has been permanently red since then.
  Filed as a P0 queue item (broken shipped test suite). Not 0079: a
  dep-graph scan shows only cairo and the new fixture change expansion.
- micropython-upstream: 513 passed, 3 failed (float/builtin_float_round,
  float/math_domain, float/math_fun_int) — pre-existing environmental
  (the known-issues class; the old "153 failures" note is long stale),
  and mp's expansion is byte-identical pre/post fix per the same scan.
- kernel + sweep: see summary in the close-out report (run after this
  log's checkpoint).

## Gotcha for the next reader

There are TWO project-json expanders (compiler.js CLI + os-common.js
bake) and they must agree on semantics; `newestBakeInput.addProject` is a
third walker but only for staleness stats (already deduped). If a fourth
grows, dedup-by-identity is part of the expansion contract now.
