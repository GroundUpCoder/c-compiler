# Cairo: the modern C 2D vector API — adopt, don't invent (todos/0061)

Landed cairo 1.18.4 + pixman 0.42.2 as the platform's 2D vector API for
new C apps (GDI stays the API for ported Win32 apps — the 0057 split).
The item's thesis held up perfectly: cairo's image backend is software
rasterization into a pixel buffer, which IS our shm window transport, so
the "backend" for windowed rendering is a ~20-line R/B swizzle blit in
the demo app. No cairo backend code was written at all.

## The compiler was the port (two fixes, zero cairo patches for them)

The most valuable output. Both were fixed test-first at the compiler
instead of patching the vendor tree:

- **Assignment setjmp forms** (`if ((status = setjmp (buf))) return
  status;`) — all SEVEN cairo scan converters use this shape; our
  lowering only supported truthiness forms. The catch already bound the
  longjmp value (`__setjmp_caught_val`); the extension assigns 0 to the
  target on the direct path and the caught value (coerced 0→1 per C11
  7.13.2.1p4, previously unobservable so never implemented) in the
  catch. Plain-identifier LHS only — the target is re-referenced in two
  synthesized sites and an arbitrary lvalue can't be evaluated twice.
  `tests/unit/stdlib/setjmp_assign`, incl. a struct-field jmp_buf with
  the retry scaffold and a re-jump leg.
- **C11 "other" pp-tokens** — the lexer hard-errored on `@ $ \`` even
  inside `#if 0` (cairo-type1-glyph-names.c carries PERL code there).
  Per C11 6.4p1 those are valid pp-tokens, only an error if they
  survive preprocessing. Unknown-char runs now lex as a deferred OTHER
  token; `emitToken` diagnoses survivors — so skipped groups and
  never-expanded macro bodies (`#define NEVER_USED @` is legal C11)
  pass, and live `@` still errors identically.
  `tests/unit/conformance/pp_skipped_other_pptoken` (clang-verified).

The ONE vendor patch: a cast in cairo-atomic-private.h's no-atomics
`_cairo_atomic_ptr_cmpxchg_return_old` macro (callers pass
`pixman_image_t **`, the fallback impl takes `cairo_atomic_intptr_t *` —
GCC warns, we error). Marked `WASM PATCH`, table in the README.

## Configuration choices

- pixman: portable C pipeline only (no SIMD `.c`/`.S`, no TLS) — the
  arch dispatch files compile to no-ops without `USE_*`. No config.h;
  two `-D` flags in lib.json. Zero patches.
- cairo: hand-written `config.h` (ILP32, `CAIRO_NO_MUTEX` + the
  mutex-based atomic fallback whose mutexes are no-ops — the same
  single-threaded model as everything else) and `cairo-features.h`
  (image/recording surfaces, ft + user fonts, png). The font-subsetting
  / pdf-operators core files compile anyway (upstream's unconditional
  list) — which makes 0080 (PDF/SVG output surfaces) small.
- freetype lib.json grew `ftmm.c` + `ftsynth.c` (cairo-ft links
  FT_Get_MM_Var / FT_GlyphSlot_Embolden). Additive for term.
- Dep gotcha → 0079: `expandProjectJson` doesn't dedup diamond deps;
  cairo listing zlib directly next to libpng (which brings zlib) = 83
  duplicate-symbol link errors. Worked around by omitting the direct
  dep; 0079 fixes it properly.

## The corpus as oracle — the acceptance that matters

`vendor/cairo/testsuite/`: 14 UNMODIFIED upstream `test/*.c` programs
under a ~40-line `cairo-test.h` shim (CAIRO_TEST → case struct; runner
replicates the harness's CLEAR-init; `cairo_test_paint_checkered`
reimplemented verbatim), compared against the UPSTREAM reference PNGs:

- **9 of 14 pixel-EXACT** (tessellator, gradient walker, 128-bit
  fixed-point, dashing, clipping — byte-identical to x86 renders).
- The other 5 differ by worst channel diff 9/255 on AA seams (the refs
  were rendered by a different pixman minor); upstream's own comparator
  is perceptual and would pass these.
- Diff policy: tol 3 + bounded outliers + HARD cap 16 — a real
  rendering error is high-contrast and always fails.

Pixel-exactness across that machinery is strong evidence for the
compiler's integer/FP codegen. Growing the subset is cheap (add a .c +
a ref + one table row) — good future conformance fodder.

## The demo + wiring

`/bin/cairodemo` (vendor/cairo/demo, seeded, menu entry, image v43):
the vector scene (radial disc, dashed ring, translucent star, bezier
ribbon, cairo-ft label from the term font pair) drawn to an SDL window;
KEYDOWN toggles dark theme; RESIZED re-renders the VECTOR scene at the
new size (crisp, not scaled pixels). `selftest` renders headless with 9
anchor asserts; `png OUT` dumps the scene.

Tests: `tests/run.py --types cairo` (smoke + selftest + upstream suite);
`tests/kernel/test_cairo_e2e.js` (in-OS selftest, wmctl shot anchors,
dark-theme repaint, `wmctl resize` → 600x450 re-render with anchors at
1.25x coords — cairodemo is the first RESIZABLE pixel-probed app);
`tests/browser/os-cairo.mjs` (same anchors through the real compositor,
keypress toggle, close-box quit). MENU_ENTRIES lists in
test_wm_service_e2e.js + os-shell.mjs got the new entry (the 0048
derive-don't-hardcode convention).

## What cairo unlocks (honest version)

Not GTK apps (pango needs glib; harfbuzz is C++ — the hard wall). It
unlocks: professional vector 2D for OUR new C apps (plotting, editors,
chrome), the 463-test upstream corpus as a compiler stressor, and 0080's
near-free PDF/SVG document output (printing) since the subsetting
machinery already compiles.
