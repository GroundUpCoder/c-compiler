# pixman 0.42.2 (vendored)

Upstream: https://www.cairographics.org/releases/pixman-0.42.2.tar.gz
(sha256 `ea1480efada2fd948bc75366f7c349e1c96d3297d09a3fe62626e38e234a625e`).
Pixel-manipulation library — cairo's raster backend (todos/0061).

## What's vendored

`pixman/` = the portable C sources from the tarball's `pixman/` dir, verbatim
(no patches): the full generic pipeline plus the four arch dispatch files
(`pixman-x86.c` etc.), which degrade to no-ops without their `USE_*` defines.
Omitted: all SIMD implementations (MMX/SSE2/SSSE3/NEON/VMX/DSPr2 `.c`/`.S`),
build files, tests, demos.

## Configuration

No `config.h` — `lib.json` passes the two defines the sources need:
`-DPACKAGE=pixman` (pixman-private.h's config guard) and `-DPIXMAN_NO_TLS=1`
(single-threaded wasm: the fast-path cache becomes a plain static).

## Testing

`bin.json` builds `test_main.c` — a composite/gradient smoke test with
analytically-verified pixel values (50% blue OVER red = `ff7f0080`), run by
the `projects` category of `tests/run.py` at compile level and exercised for
real by cairo's own test binary (`vendor/cairo/bin.json`).
