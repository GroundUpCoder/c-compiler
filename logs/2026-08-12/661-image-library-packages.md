# #661 — standalone zlib, pixman, cairo and giflib source packages

Lane `lane-661`, base `2744fd5c`. jku promoted this by email on 2026-08-12
("it has a lot of downstream impact since things that depend on them could
use them"), which is why it ran ahead of the light correctness queue.

Epic: **pkgdev** (a reusable dependency substrate is what lets a package be
developed in-OS without re-deriving someone else's build graph) and
**gamedev** (compressed assets, image decode, software compositing and
drawing are all on the path of building a game inside gucOS).

## What the missing layer actually was

All four libraries were already vendored and already had a `lib.json`. The
gap was one `packages/<name>.json` each — plus, for three of them, the
`__require_source` block that makes a bare `#include` link the library
(source-lib §4.2, the ft2build.h pattern). `<zlib.h>` already had one;
`<pixman.h>`, `<cairo.h>` and `<gif_lib.h>` did not.

## libpng → zlib: a real conflict, not a tidiness question

`packages/libpng.json` shipped `include/zlib.h`, `include/zconf.h` and
`src/z` → `vendor/zlib/src`, and its summary called itself "libpng + zlib".
That is not merely duplication:

- **gucman refuses to overwrite an existing plant** (`gm_exists(link)` →
  "already exists — refusing to overwrite"), so a standalone zlib package and
  libpng could never have been installed on the same system.
- The baked fold has the same property via `claim()`. Measured directly, with
  the pre-#661 libpng definition read out of git and folded next to the new
  zlib definition:

      PRE-#661  libpng(ships zlib) + zlib:
          REFUSED -> package 'zlib': /usr/include/zconf.h conflicts with an
                     existing image entry
      POST-#661 libpng(deps zlib)  + zlib:
          folded OK (no collision)

So the split was a precondition for a zlib package existing at all, not a
cleanup after one. libpng now declares `deps: ["zlib"]` (1.6.58-3 → -4) and
ownership is exactly one package per vendor tree:

| tree | before | after |
|---|---|---|
| `vendor/zlib` | libpng | **zlib** |
| `vendor/libpng` | libpng | libpng |
| `vendor/pixman` | — | **pixman** |
| `vendor/cairo` | — (cairodemo builds a binary) | **cairo** |
| `vendor/giflib` | — | **giflib** |

The split is deliberately INVISIBLE to a libpng consumer: `gucman install
libpng` still plants `/usr/local/include/zlib.h` and `/usr/local/src/z`,
now through the dependency. `test_cc_libpng_e2e.js`'s four assertions about
that are unchanged on purpose.

## cairo → pixman: dependencies, and no second copy

`cairo.json` declares `deps: ["pixman", "libpng", "zlib", "freetype"]`,
matching `vendor/cairo/lib.json`. `<cairo.h>`'s require block lists ONLY
cairo's own 121 TUs — pixman rides in through `cairoint.h`'s `<pixman.h>`,
libpng and zlib through `cairo-png.c`, freetype through `cairo-ft-font.c`.
Each of those headers owns its own block, so no set is restated.

## Two things that were not obvious

**pixman could not be packaged as-is.** Its sources need `-DPACKAGE=pixman`
and `-DPIXMAN_NO_TLS=1`, and a required TU is compiled under the *consumer's*
options — a require block cannot carry per-library flags. This is a settled
rule, not a new discovery: `vendor/freetype/srclib/ftbase.c` says an
FS-require-able source must be a self-contained TU (§3.4) and puts its own
build defines in the file, ifndef-guarded. `pixman-private.h` — which every
pixman TU includes, and which is where the `#error config.h must be included
before pixman-private.h` guard lived — now does the same. `lib.json` keeps
passing both defines, exactly as freetype's does; the guards make them agree.
Verified byte-identical: pixman's `test_main.c` links to `aec4925b…` with the
flags, without them, and before the patch.

**giflib needed no patch at all.** Its `lib.json` passes `--allow-old-c`, but
the four vendored TUs compile clean under the strict default (byte-identical
output, `e22e33b8…`), so a consumer that cannot pass flags still links them.
`lib.json` is left alone; the in-OS e2e now pins the strict-default path, so
a future K&R addition that only builds host-side fails loudly instead of
silently breaking the package.

**cairo's `config.h` sits inside the src payload dir.** Cairo TUs reach it by
quote-include from their own directory (`cairoint.h`'s `#include "config.h"`),
and there is no `-I` in the in-OS path. `packages/cairo.json` therefore maps
`src/cairo` → `vendor/cairo/src` *and* `src/cairo/config.h` →
`vendor/cairo/config.h`. Legal because mkpkg's `claim()` only refuses a path
produced twice, and `vendor/cairo/src` has no `config.h` of its own. Shipping
it at the include tier was rejected: `/usr/local/include/config.h` is a
maximally generic name that would collide with any other package.

## Retained duplication, and why

Each package ships its public headers twice — once under `include/` for the
include tier, once inside the src tree the sources quote-include. This is
inherent to the substrate (the payload is a symlink-free tar, and the two
tiers are planted from different dirs) and is the existing pattern: libpng,
libjpeg and zlib all already do it. Cost is a few KB per package.

## The drift gate

The §4.4 table moved to module scope as `SRCLIB_TABLE`, the `z` row was
reassigned from `packages/libpng.json` to `packages/zlib.json`, and the three
new libraries joined it. `tools/mkpkg.js` used to carry a parallel hardcoded
list of the six gated names; it now DERIVES the set (`srclibDriftPackages()`).
A package added to the table but forgotten in that second list would have
built with its drift check silently skipped — the exact failure class the
gate exists to prevent.

## No image version bump — measured, not assumed

The shipped image is the MINIMAL bake (#615), and packages publish on their
own cadence, so four new packages do not change what users get; the fat
fixture re-bakes off its `bakedPackages` set without a version gate.

The one baked binary that could have moved is `mgp`
(`vendor/magicpoint/image/gif.c` includes `gif_lib.h`, and mgp is
`/usr/bin/mgp` in image.json). Adding a require block to that header could
have double-compiled giflib into it. It does not: `giflib/lib.json` gained
`srcRoots {gif: "."}`, so each require resolves to the same physical path as
the already-listed TU and dedups away. Proven by building mgp with and
without the block — both `44485275…`. `os/doc/toolchain.md` changed, which is
a bake input, so the image was resealed before gating.

## Coverage

`tests/kernel/test_cc_imagelibs_e2e.js` (20 legs, registered in
`tests/kernel/run.js` — the member registry refuses an unlisted on-disk test):

- fat image: `<pixman.h>` composites, `<cairo.h>` draws (proving pixman
  transitively), `<gif_lib.h>` REALLY DECODES an embedded 2×2 GIF87a —
  palette and per-pixel indices asserted, not a header-only compile. Each has
  its `-D<LIB>_NO_REQUIRE_SOURCES` hatch as a red control that must fail at
  link naming a library symbol.
- minimal image + the served index: absence is honest, then `gucman install
  zlib` STANDALONE, then `libpng` ON TOP OF IT (the ownership guard — this is
  the install that could not have worked before), then `cairo` pulling pixman
  and freetype through `deps[]`, then `giflib`. Finally `gucman remove zlib`
  must refuse and name libpng and cairo, which is what proves the dependency
  edges are recorded rather than merely declared.
