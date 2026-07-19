# cairo 1.18.4 (vendored)

Upstream: https://www.cairographics.org/releases/cairo-1.18.4.tar.xz
(sha256 `445ed8208a6e4823de1226a74ca319d3600e83f6369f99b14265006599c32ccb`).
The platform's modern 2D vector API for new C apps (todos/0061 — adopt,
don't invent; GDI stays the API for ported Win32 apps).

## What's vendored

`src/` = the unconditional core source list from upstream `src/meson.build`
plus the `cairo-png` and `cairo-ft` feature sources, and all of `src/*.h`.
Omitted: every platform surface backend (xlib/xcb/quartz/win32/gl), the
script/pdf/ps/svg/tee surfaces, and their headers. The font-subsetting +
pdf-operators files ARE kept (they're in upstream's unconditional list and
link fine; the deflate stream rides the vendored zlib).

Backends enabled (`src/cairo-features.h`, hand-written): image surface
(software rasterization into a pixel buffer — the shm window transport),
recording/observer/mime surfaces, user + toy fonts, FreeType fonts
(`cairo-ft`, no fontconfig), PNG functions (vendored libpng). The color-font
renderers (`cairo-colr-glyph-render.c`, `cairo-svg-glyph-render.c`) compile
empty: our minimal FreeType has no `FT_COLR_V1`/`FT_SVG_Document`.

`config.h` is hand-written for wasm32: ILP32, little-endian, and
single-threaded — `CAIRO_NO_MUTEX=1` plus no `HAVE_*_ATOMIC_*`, which selects
the mutex-based atomic fallback in `cairo-atomic.c` whose mutexes are no-ops
(same single-threaded model as the rest of the OS).

Deps (`lib.json`): pixman (raster backend), libpng (which brings zlib),
freetype (reusing `vendor/freetype/demo/`'s custom `ft2build.h` config, the
same one term uses).

## Patches (vs upstream 1.18.4)

| file | change | why |
|---|---|---|
| `cairo-atomic-private.h` | cast in the no-atomics `_cairo_atomic_ptr_cmpxchg_return_old` macro | callers pass typed pointer-pointers (`pixman_image_t **`); the fallback impl takes `cairo_atomic_intptr_t *`. GCC warns, our compiler errors. One-line, marked `WASM PATCH`. |

Cairo's setjmp-value idiom (`if ((status = setjmp (...)))` in all seven scan
converters) and the perl code inside `#if 0` in `cairo-type1-glyph-names.c`
needed no patches — the compiler grew the assignment setjmp forms and
C11-conformant "other" pp-token handling instead (0061; tests
`tests/unit/stdlib/setjmp_assign`, `tests/unit/conformance/pp_skipped_other_pptoken`).

## Testing

`bin.json` builds `test_main.c`: fills, AA arcs, bezier strokes, linear
gradients, clipping — checked by sampling pixels with AA-tolerant asserts —
plus cairo-ft text rendering (pass a .ttf path as argv[1]) and a PNG
round-trip through the vendored libpng:

```bash
node compiler.js vendor/cairo/bin.json -o build/cairo-test.wasm
node --experimental-wasm-exnref host.js build/cairo-test.wasm vendor/fonts/NotoSansMono-Regular.ttf
# -> cairo 1.18.4 ok
```

The windowed demo seeded into the OS is `/bin/cairodemo` (`demo/`): the
vector scene (radial disc, dashed ring, translucent star, bezier ribbon,
cairo-ft label) drawn into an SDL window surface; `cairodemo selftest`
renders it headless with anchor-pixel asserts, `cairodemo png OUT` dumps it.

## Upstream test suite (`testsuite/`) — the corpus as oracle

14 UNMODIFIED programs from upstream `test/` (fill-rule, caps-joins, paint,
gradient-alpha, linear-gradient-reflect, rounded-rectangle-fill/-stroke,
dash-curve, miter-precision, random-intersections-eo, mesh-pattern-overlap,
clip-fill, unaligned-box, close-path) compiled against a minimal
`cairo-test.h` shim (`CAIRO_TEST` registers a case struct; runner.c
replicates the harness's CLEAR-init and reimplements
`cairo_test_paint_checkered` verbatim) and compared against the UPSTREAM
reference PNGs in `testsuite/reference/`:

```bash
node compiler.js vendor/cairo/testsuite/bin.json -o build/cairotests.wasm
node --experimental-wasm-exnref host.js build/cairotests.wasm vendor/cairo/testsuite/reference
# -> cairotests: 14 upstream tests ok   (9 of them pixel-EXACT)
```

Diff policy (runner.c): per-channel TOLERANCE 3 with a bounded outlier
count for AA-seam jitter vs the pixman that rendered the refs (observed
worst 9/255), and HARD_TOLERANCE 16 — any real rendering error produces
high-contrast pixels and fails regardless. `tests/run.py --types cairo`
runs the smoke test, the demo selftest, and this suite.
