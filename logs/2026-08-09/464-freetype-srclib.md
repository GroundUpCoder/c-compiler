# #464 — FreeType as a standalone srclib package (PKGDEV rung 2)

FreeType existed in-OS only as payload the `win32` package happened to own:
an in-OS developer could not install it, depend on it, or build against it
without dragging the whole Win32 veneer in. This lane makes it the third
standalone srclib package (after libpng/libgit2) — and the first whose own
header carries the link metadata.

## What moved where

- **`packages/freetype.json`** (new): the three demo headers (`ft2build.h`,
  `myftmodule.h`, `myftoption.h`), the `include/freetype` tree, the 12 shim
  TUs (`srclib/`) and the upstream `src/` tree the shims' `../src/...`
  relative includes need — siblings at the payload root, so the §3.3 layout
  invariant (`srclib/../src/base/ftbase.c`) holds in the new payload exactly
  as it did inside win32's.
- **`packages/win32.json`**: `deps: ["freetype"]`, freetype payload gone
  (274 KB, down from ~1 MB). gucman's existing depth-first dep install
  (netsurf-demos precedent) pulls freetype transitively; remove does NOT
  cascade (existing contract — asserted in the gucman e2e now).
- **The require block**: out of `gdi32.c`, into the project-owned
  `vendor/freetype/demo/ft2build.h`, guarded by `FT_NO_REQUIRE_SOURCES`
  (the WIN32_NO_REQUIRE_SOURCES analog). Including the header IS the link
  metadata now — the windows.h/§4.1 pattern applied to the library itself,
  which is what makes `cc ftdemo.c` work bare: no -I, no TU list, no win32.
  §4.2's "vendor knowledge stays with its consumer" is amended, not
  violated: the consumer of the freetype *sources* is the freetype
  *package*, and gdi32.c's `#include <ft2build.h>` still pulls everything
  it pulled before, transitively.
- **Host-side no-op by construction**: every project that can see the demo
  `ft2build.h` (term, ksvc, deck, win32, menucore, netsurf, cairo, sent,
  magicpoint, mgpp — the `includes` list and the lib.json `deps` list match
  exactly, checked) also deps `vendor/freetype/lib.json`, whose
  `srcRoots {freetype: srclib}` resolves each require to the SAME path as
  the explicitly-listed TU → path-identity dedup no-ops the block.

## The drift gate (§4.4) after the move

`win32RequireDriftErrors` now checks, in place of the old gdi32.c diff:

- `ft2build.h`'s require set == `vendor/freetype/lib.json` sources;
- `gdi32.c`'s require set is **EMPTY** — pinned, so the metadata cannot
  quietly grow a second, driftable copy;
- the freetype payload half at FILE level: the package maps namespace
  `freetype` to the `vendor/freetype/srclib` tree and every lib.json
  source exists in that tree. (win32's `unshipped()` check works off
  per-file payload keys; a `tree` entry has none, hence the explicit
  file-existence walk.)

mkpkg runs the gate for `freetype` builds as well as `win32`. Negative
controls exercised by hand before landing: a dropped shim, a require
re-grown in gdi32.c, a payload missing a required shim, and a remapped
namespace — all four refuse with the right message.

## Tests

- `test_cc_freetype_e2e.js` (new, XL class via the `ensureMinimalImage`
  textual rule): fat-image bare compile + REAL glyph render from the baked
  mono.ttf; `-DFT_NO_REQUIRE_SOURCES` must fail at link (the red control
  proving the header block was the link metadata); minimal image fails
  clean → `gucman install freetype` (no win32 anywhere — asserted) → same
  compile + run through the installed tiers.
- `test_gucman_e2e.js`: session D asserts the transitive dep install, the
  freetype-owned plants (`/opt/freetype/srclib`), no win32-owned freetype
  namespace, dep survival across `remove win32`, and tier teardown only
  after the LAST srclib package goes; session E asserts the baked twin
  (`/usr/opt/freetype`) and no duplicate tree under `/usr/opt/win32`.
- `test_cc_win32_e2e.js` / `test_defaults_sync_e2e.js`: repos carry
  freetype; the win32 install leg asserts the transitive pull.

Image v247 → v248: `ft2build.h` is a bake input (ksvc/term/deck), and the
fold layout moved — a persistent browser OPFS image must re-fetch.

## Surfaced, not fixed

`gucman remove` has no reverse-dependency check — `remove freetype` with
win32 installed leaves win32's compiles broken until reinstall. Existing
platform behavior (deps predate this lane; netsurf-demos has the same
exposure), noted for the #545-adjacent upgrade/remove hardening work
rather than silently scoped in here.
