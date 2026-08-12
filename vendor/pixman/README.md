# pixman 0.42.2 (vendored)

Upstream: https://www.cairographics.org/releases/pixman-0.42.2.tar.gz
(sha256 `ea1480efada2fd948bc75366f7c349e1c96d3297d09a3fe62626e38e234a625e`).
Pixel-manipulation library — cairo's raster backend (todos/0061).

## What's vendored

`pixman/` = the portable C sources from the tarball's `pixman/` dir: the full
generic pipeline plus the four arch dispatch files (`pixman-x86.c` etc.), which
degrade to no-ops without their `USE_*` defines. Omitted: all SIMD
implementations (MMX/SSE2/SSSE3/NEON/VMX/DSPr2 `.c`/`.S`), build files, tests,
demos.

### Patches

| File | Change | Ticket |
|---|---|---|
| `pixman/pixman-private.h` | Upstream's `#ifndef PACKAGE / #error config.h must be included first` guard becomes an ifndef-guarded **self-configuring** `#define PACKAGE pixman` + `#define PIXMAN_NO_TLS 1`. | #661 |

Everything else is verbatim.

## Configuration

No `config.h`. The two defines the sources need — `PACKAGE`
(pixman-private.h's config guard) and `PIXMAN_NO_TLS` (single-threaded wasm:
the fast-path cache becomes a plain static) — are supplied by
`pixman-private.h` itself, which every pixman TU includes.

They live in the header because a source-library package's TUs are pulled in by
the in-OS `cc` through `<pixman.h>`'s `__require_source` block and compiled
under the **consumer's** options: an FS-require-able source must be a
self-contained TU with no per-TU compilerArgs (source-lib §3.4, the same rule
the freetype srclib shims follow). `lib.json` keeps passing both defines for
host project builds — the `#ifndef` guards make the two agree by construction,
and the resulting wasm is byte-identical with the flags, without them, and
before the patch.

## Testing

`bin.json` builds `test_main.c` — a composite/gradient smoke test with
analytically-verified pixel values (50% blue OVER red = `ff7f0080`), run by
the `projects` category of `tests/run.py` at compile level and exercised for
real by cairo's own test binary (`vendor/cairo/bin.json`).
