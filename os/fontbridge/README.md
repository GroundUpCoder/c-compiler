# Process-local font bridge (ABI 1)

`/usr/lib/fontbridge.wasm` is built with this compiler from the existing FreeType
and fontcore code. Each calling process lazily loads its own instance. Its memory
is separate from the caller's memory. The host reads font bytes through the application's
filesystem once per face, then opens memory-backed FreeType faces. Glyph and run
operations execute locally, with no kernel RPC, browser font API or Canvas2D.
The memory-only module traps attempted filesystem/process imports.

`<gucos/fontbridge.h>` declares the C imports. It is a compiler builtin header
(compiler.js standardHeaders), baked to `/usr/include/gucos/fontbridge.h` by the
same fold as every other builtin. Other Wasm producers can declare the same
`c` imports with ordinary scalar signatures. `path`/UTF-8/pixel pointers address the caller's linear
memory. Fonts and results are opaque positive handles. No module pointer crosses
into caller memory. `__font_abi()` returns 1; a missing installed module fails
loudly when opening a font, and a mismatched module ABI throws before use.

- `__font_open(path, pixels, flags)` returns a font handle. A null path resolves
  `/etc/fonts/mono.ttf`, then `/usr/share/fonts/mono.ttf`. Non-null selects an exact
  path. Sizes are 1–256 pixels. Flag 1 synthesizes fontcore's half-weight bold;
  flag 2 uses fontcore's italic shear; 0 is regular. These flags are custom,
  not a claim to select a family's authored bold/italic faces. Use a file path
  to select an authored face.
- `__font_add_fallback(font, path)` appends an explicit fallback face and clears
  that font's glyph cache. Fallback order is the caller's order. Fontcore's
  primary-face ASCII policy and synthesized missing-glyph box are retained.
  It does not implicitly read the terminal/kernel's fontchain configuration.
- `__font_metric(font, field)` returns ascent (0), positive descent (1), line
  height (2), M/cell advance (3), cached bitmap bytes (4), or face count (5).
  Measurements are integer pixels from the same FreeType size/load discipline.
- `__font_glyph(font, UnicodeScalar)` returns an owned result handle.
- `__font_codepoint_run(font, utf8, byteLength)` returns an owned result for a
  left-to-right sequence of Unicode scalars using integer glyph advances. Input
  must be strict UTF-8; C0 controls and non-scalars are rejected. This custom name
  explicitly provides codepoint layout: no shaping, kerning, bidi reordering or
  grapheme navigation is implied. Caller text layout may instead use glyph results.
- `__font_result_field(result, field)` returns width (0), height (1), left bearing
  (2), top bearing above baseline (3), advance (4), or required RGBA bytes (5).
  Place the bitmap at `(penX + left, baselineY - top)`. Empty results are valid.
- `__font_result_copy(result, ptr, capacity, rgba)` copies RGBA8 pixels tinted by
  `0xRRGGBBAA` and returns bytes copied. A short buffer is rejected before writing.
  Upload through existing SDL texture APIs and reuse that texture for warm draws;
  do not repeat glyph reads/uploads for every repaint.
- `__font_result_release(result)` releases its owned bitmap. Results survive
  subsequent glyph/run calls, cache eviction, caller memory growth and font close.
- `__font_close(font)` releases its faces, bytes and cache. `__font_dispose()`
  closes all fonts and results; the bridge remains reusable. Handles are never
  recycled within a bridge lifetime, including after dispose. Process teardown
  naturally releases the process-local instance and JS result storage.

Mutations that return status return 0 on success. Negative results denote
invalid argument/handle (-1), capacity/allocation limit (-2), invalid font or
rasterization failure (-3), missing/unreadable file (-4), or invalid UTF-8 (-5).
Glyph/run failures return -3 when the module cannot produce a descriptor.

Bounds: 16 open fonts, 8 faces/font, 64 MiB total retained font bytes, 64 cached
glyphs and 512 KiB bitmap cache/font, 4096 scalars/16384 UTF-8 bytes/run, an 8 MiB
run bitmap scratch, 32 retained result handles and 32 MiB total result A8 storage.
RGBA export is four times A8 size. Temporary file/staging bytes and FreeType's
own parsing allocations are additional; these are not claimed as total RSS caps.
LRU glyph eviction frees bitmaps. A cache-budget crossing clears that font's
cache before insertion. Old external bitmap results remain valid.

Focused acceptance is `node tests/host/test_fontbridge.js`: real compiled module,
bitmap ink/metrics, cache and result bounds, malformed text, stale handles,
memory growth and teardown.
Graphical acceptance and CPU/GPU performance are separately recorded under #791.
