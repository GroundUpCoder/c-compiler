# 0079 — Project files: dedup diamond deps (zlib-via-two-paths = duplicate symbols)

- **Status**: open
- **Design**: this file (found during 0061)

## Goal

`compiler.js`'s `expandProjectJson` expands `deps` recursively with NO
dedup: a diamond (A depends on zlib and on libpng, libpng depends on zlib)
compiles zlib's sources twice → 83 "Duplicate definition of symbol" link
errors. 0061 hit this wiring cairo (deps: pixman + libpng + freetype;
libpng already brings zlib) and worked around it by dep hygiene — cairo's
lib.json deliberately omits the direct zlib dep it conceptually has.

Fix: dedup expanded project JSONs by resolved absolute path (first
occurrence wins, later ones no-op — the include flags they contribute are
already position-independent). A lib listed twice via different paths
(symlinks) should also collapse: key on `fs.realpathSync`.

## Plan

- `expandProjectJson`: thread a `seen` Set of realpaths; skip re-expansion.
- Restore the honest dep in `vendor/cairo/lib.json` (`../zlib/lib.json`)
  as the regression proof.
- Unit-level check: a fixture bin.json with a diamond dep compiles clean
  (tests/unit or a projects-category case).

## Acceptance

- cairo's lib.json lists zlib directly AND via libpng; `node compiler.js
  vendor/cairo/bin.json` links clean.
- No behavior change for existing projects (`tests/run.py --types projects`).
