# #498 — srclib headers carry their own require blocks

The defect (re-measured in-OS by the coordinator at 2ee261c0, fat image):
`<zlib.h>`, `<png.h>` and `<jpeglib.h>` sat on the default include path
with their sources on the default source path — both planted by the same
package — and the in-OS `cc` still failed at link with a bare
`Undefined symbol`. FreeType was the one library that got fixed (#464:
the block lives in the shipped `ft2build.h`); the decoder set never did.
Two greens masked it: the libpng e2e proved the SDL_image path (the
consumer carried the block), and the libjpeg e2e wrote the TU list into
its own test program.

## What landed

**The #464 pattern, applied per library.** Five headers gain guarded
`__require_source` blocks: `vendor/zlib/src/zlib.h` (z/10),
`vendor/libpng/png.h` (png/15), `vendor/libjpeg/jpeglib.h` (jpeg/46),
`vendor/netsurf/libnsgif/include/nsgif.h` (nsgif/2),
`vendor/netsurf/libnsbmp/include/libnsbmp.h` (nsbmp/1). Hatches:
`ZLIB/PNG/JPEG/NSGIF/NSBMP_NO_REQUIRE_SOURCES`. Not three headers one at
a time: with these five, SIX of the seven srclib packages carry their
own link metadata (freetype and win32 already did); libgit2 is the
deliberate residual (below).

**Decisions worth recording:**

- *zlib knowledge stays out of png.h.* The png block lists only png TUs;
  the z set arrives transitively because pngstruct.h includes `"zlib.h"`,
  which falls through to the include tier and fires the z block. Vendor
  knowledge stays with its consumer — no cross-library union anywhere.
- *The second copies are deleted, not tolerated.* `__SDL_image.c`
  (compiler.js) and `os/win32/gdiplus.c` both hand-carried the z+png
  (+jpeg+nsgif+nsbmp) lists. Name-keyed require dedup would have made
  the duplicates harmless, but a copy that CAN drift eventually does —
  gdiplus.c is pinned EMPTY by the gate (the gdi32.c/#464 rule) and
  `__SDL_image.c` now links libpng purely through its `#include <png.h>`.
  The "SDL stays libpng-free" intent (compiler.js §SDL_image comment)
  survives structurally: `<SDL3/SDL.h>` never reaches `<png.h>`.
- *The gz\* family is deliberately NOT in the zlib block* — it is not in
  `vendor/zlib/lib.json` sources (netsurf-core lists the four gz TUs it
  wants explicitly). A `<zlib.h>` user calling `gzopen` still gets a
  link error; the honest fix if that ever matters is promoting gz\* into
  lib.json, not padding the header block past its lib.json truth.
- *Drift gate generalized, not multiplied.* os-common
  `win32RequireDriftErrors` now walks a `srclibs` table (header ↔
  lib.json ↔ package tree, the freetype IIFE generalized to all six) and
  pins BOTH consumer TUs empty. mkpkg runs the gate for
  libpng/libjpeg/libnsbmp/libnsgif builds too.
- *Host builds are provably no-ops.* Path-identity dedup: ztool and sent
  byte-identical before/after; netsurf compiles the SAME 2415 TUs (the
  only byte delta between trees is the embedded absolute source-path
  prefix, counted and matched to the size delta). The clang sibling is
  safe by its own design: cc2wasm force-includes `compat.h`, which
  no-ops `__require_source` (documented in the sibling's wasm/README).
- *vendor/cpython/bin.json gains `srcRoots {z}`.* It lists the zlib TUs
  directly with no lib.json dep; our compiler doesn't build it today
  (compileCheck false — the sibling reads its `sources`), but the shared
  definition should not be one flag-flip away from an unresolvable
  require.
- *netsurf patch record:* the two libns headers are netsurf-constellation
  files, so the edits are mirrored as `patches/libnsgif.diff` +
  `patches/libnsbmp.diff` (their components' first sections) and
  `pristine.json` regenerated — residual shas verified equal to the
  pre-edit upstream bytes.

**Tests.** `test_cc_libpng_e2e.js` and `test_cc_libjpeg_e2e.js` rewritten
to the freetype two-session shape: fat-image standalone round trips
(png-only, zlib-only, jpeg encode→decode with exact pixels), hatch legs
that must FAIL at link (the anti-vacuity red controls), and minimal-image
sessions (absence honest → `gucman install` → standalone works through
`/usr/local/{include,src}`). The libpng minimal session also asserts the
`<SDL3/SDL.h>`-only program links and runs LIBPNG-FREE — measured on the
one image that can prove absence. The SDL_image veneer round trip stays
as the regression leg. No registry membership change (both files
existed); BOOT weight tags dropped (each file now drives two boots —
untagged is the safe default per the #579 rule).

## Residual: libgit2

`<git2.h>` (git2_srclib.h tier) stays without a block. It is structurally
different: libgit2 vendors its own zlib copy under `deps/zlib` (a
same-named `zlib.h` that shadows ours inside the tree), its usable TU set
is the curated 100+ list in `os/git/bin.json` rather than a lib.json this
gate reads, and nothing has measured what an in-OS whole-libgit2 compile
per consumer TU costs. That is a ticket-sized decision, not a silent
skip — reported to the coordinator rather than half-done here.

## Containers

- Vendored headers + packages/*.json → package payloads: versions
  suffixed `-2` (libpng 1.6.58-2, libjpeg 9f-2, libnsbmp/libnsgif
  1.0.0-2).
- compiler.js (`__SDL_image.c`) + os/win32/gdiplus.c (win32 package,
  folded fat) → bake inputs of the fat image: os/image.json v254 → v255
  (the #464 precedent — same container mix, same call).
