# 0448 / #93 — vendor IJG libjpeg + flip NetSurf WITH_JPEG

Ticket #93. Branch `0448-libjpeg`. Two wins from one vendoring job: the in-OS
`cc` can compile JPEG code, and NetSurf renders JPEG images.

## What landed

- **`vendor/libjpeg/`** — IJG libjpeg **9f** (`jpegsrc.v9f.tar.gz`, sha256
  `04705c110cb2469caa79fb71fba3d7bf834914706e9641a4589485c1f832565b`). The
  source set is `Makefile.am`'s `LIBSOURCES` (45 files) plus `jmemnobs.c`
  (the no-backing-store memory manager, the same one `configure` selects).
  Omitted on purpose: the command-line tools (`cjpeg`, `djpeg`, `jpegtran`,
  `rdjpgcom`, `wrjpgcom`, `cdjpeg.c`, `rd*.c`/`wr*.c`, `transupp.c`), the
  alternate memory managers (`jmemansi/jmemname/jmemdos/jmemmac`), and the
  build system. `LICENSE` is the verbatim upstream README — its condition (1)
  requires that file to travel with any source distribution. The version is
  pinned in `lib.json`'s `description` and `packages/libjpeg.json`'s
  `version` (the libpng convention; there is deliberately no UPSTREAM.json).
- **`vendor/libjpeg/jconfig.h`** — hand-written (upstream generates it).
  Every option and the reason for it is documented in the file header. Short
  form: plain ANSI, all pre-ANSI escape hatches off, signed plain char,
  arithmetic signed right shift.
- **`packages/libjpeg.json`** — srclib package: public headers (`jpeglib.h`,
  `jmorecfg.h`, `jconfig.h`, `jerror.h`) under `/usr/include`, the tree under
  `/usr/src/jpeg`. There is no veneer consumer, so a program carries its own
  `__require_source("jpeg/…")` block — the `windows.h`/`__SDL_image.c`
  pattern with the block on the consumer side.
- **NetSurf**: `netsurf-core.json` gains `-DWITH_JPEG` and
  `netsurf/content/handlers/image/jpeg.c` (the upstream handler was already
  in the tree, just not compiled); `bin.json` and `gucos/bin.json` dep
  `../libjpeg/lib.json` the same way they dep libpng. **No file under
  `vendor/netsurf/netsurf/` changed** — the upstream handler compiles
  unmodified against classic IJG (its `RGB_PIXELSIZE != 4` branch does the
  RGB→RGBA conversion), so the patchcheck fence is untouched and no new
  `.diff` section exists.
- **`tools/mkwebfixtures.js`** grew a dependency-free baseline JPEG encoder
  (DC-only blocks, all-ones quant table, Annex K Huffman tables) and writes
  `teal.jpg` + the fifth `<img>` in `images.html`. The four old fixtures
  regenerate byte-identically (round trip proven by an empty diff).
- **Image v216 → v217**: the baked `/usr/bin/netsurf` changes (JPEG handler
  linked in), so the base image cannot stay byte-identical. The libjpeg
  srclib package itself folds into the FAT image only (`PACKAGES=` gains
  `libjpeg`), exactly like libpng — the base image does not carry it.

## Golden testdata (`vendor/libjpeg/testdata/`)

JPEG decode is only pixel-exact against the SAME decoder implementation
(the spec gives IDCT freedom), so the oracle is a **cross-compiler
differential**: clang-native (LP64, arm64) builds of the vendored tree
generate the goldens, and the wasm build (ILP32, our compiler) must match —
decode pixel-exact, encode byte-identical. Recipe:

```
clang -O2 -o jtest-native vendor/libjpeg/*.c        # includes test_main.c
node -e '<deterministic pixel generator>'            # writes <base>.rgb
./jtest-native write <base>.rgb <base>.jpg <base>.jpg [prog|ari|gray]
./jtest-native dump  <base>.jpg <base>_dec.rgb
# corrupt.jpg = gradient_16x16.jpg truncated to 1/3 + every 7th byte ^0xa5
```

Six bases cover baseline, progressive (`prog_*`), arithmetic (`ari_*`),
grayscale (`gray_*`), flat colour, and an all-frequency pattern
(`freq_32x32`). `corrupt.jpg` is the can-fail control: decode must reject it
through the error manager. run.py category `libjpeg` = 13 tests (6 read +
6 write + corrupt), all green; a deliberately mismatched reference fails
(exit 1), so the harness can go red.

## Tests

- `tests/kernel/test_cc_libjpeg_e2e.js` — in-OS `cc` builds an
  encode→decode round trip against the folded package (no `-I`, no TU list;
  the program's own require block pulls `/usr/src/jpeg`), asserts EXACT
  decoded pixels (from the clang-native golden) and corrupt-stream
  rejection. Kernel registry: 145 declared + 1 excluded → **146 declared +
  1 excluded = 147 on disk** (the #314 guard refused the run until the file
  was registered — working as designed).
- `test_netsurf_content_e2e.js` — new leg: `teal.jpg` decodes and lands at
  (16,240) on the framebuffer. The old "JPEG deliberately NOT covered"
  comments are gone.
- `tests/run.js`: `libjpeg` joins PY_CATEGORIES; `^vendor/libjpeg/` maps to
  `libjpeg, projects, kernel, sweep`.

## Decisions

- **Classic IJG, not libjpeg-turbo** — per the ticket (turbo brings SIMD +
  a build system; the corpus needs neither).
- **No SDL_image JPEG decoder, no viewer, no association** — out of scope by
  the ticket's own red line; 0453/0454 own the viewer chain.
- **Consumer-carried require block** accepted as the srclib idiom (the
  design's §3.1 shape). A convenience header would be a new convention —
  not this ticket's call to make unilaterally.
