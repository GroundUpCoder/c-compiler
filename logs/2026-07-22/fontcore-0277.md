# 0277 — fontcore: ONE header-only glyph pipeline for gdi32/term/ksvc

The estate carried THREE copies of the chain-probe / tofu / two-tier-cache /
glyph-render / UTF-8 discipline — gdi32 `font_glyph`, term `cp_glyph`, ksvc's
pipeline — agreeing only by convention. Consolidated into `os/fontcore.h`
(the fontchain.h / fileops.h / openwith.h header-only precedent). This is the
0275 §14.4 follow-up.

## What moved into fontcore.h

- `FcGlyph` / `FcCache` + `fc_cache_get` — the flat[95]-ASCII + linear-scan
  side cache, with the OOM-falls-back-to-'?' path. Render happens through an
  `FcRenderFn` callback (`(ctx, g, cp) -> g`) so the cache is consumer-agnostic.
- `fc_u8_next` — the one-shot UTF-8 stepper (U+FFFD past a bad lead byte only).
- `fc_tofu(g, cell, ascent, cp)` — the synthesized gap-marker box (cell ×
  wcwidth), pure function of the two metrics.
- `FcChain` + `fc_chain_init` / `fc_chain_face` — lazy-open + dead-mark +
  **resize-on-demand** chain-face accessor. The resize-on-demand unifies the
  two flavors byte-identically: a fixed-size consumer (gdi32 per-HFONT, term)
  sets the size once and never re-sizes (curPx == px thereafter); ksvc, which
  shares faces across size slots, re-sizes on the px change it already did.
- `fc_probe(face0, chain, px, cp, gi)` — face-0-then-list probe.
- `fc_render_face(g, face, gi, opts)` — the one FT_Load / embolden / advance /
  FT_Render / copy / threshold sequence. `FcRenderOpts{mono_threshold,
  bold_xdelta}` parameterizes the ONLY two per-consumer knobs: gdi32's
  NONANTIALIASED 1-bit cut (96) and ksvc's outline embolden (0x0555). term
  passes {0,0}.

Adapters keep their own face-0 lifecycle + metric extraction (too
consumer-specific to share: gdi32 per-HFONT eager-with-metrics, term global
eager, ksvc global resize-on-demand) and supply the render callback. Net
−273 LOC across the three sources.

## Byte-identical is the acceptance bar (not module bytes)

The wasm MODULES got bigger (ksvc 276433 → 277248, +815 B): the `FcRenderFn`
function-pointer seam blocks the inlining the monolith had. That's fine — the
bar is byte-identical **rendered output**, not module size.

Verified directly for ksvc: built the baseline blob (main) and the new blob,
instantiated both over the SAME baked image via `os/ksvc.js` (proxying only
`/usr/lib/ksvc.wasm`), and bit-compared `render()` + `measure()` across 13
strings × 5 px × {regular,bold} × 4 maxW = **520 renders, 0 diffs** (ASCII,
mixed, CJK-tofu, ellipsis-truncation, embolden all exercised). gdi32/term go
through the same fontcore functions; their byte-identity rides the fontpkg +
ksvc same-bytes e2es (real fallback-glyph render) and term's browser goldens.

## Concurrency: win32_internal.h left alone (deliberate)

`win32_internal.h`'s `__u8_next` is the "4th copy" of the stepper, but it also
serves user32's EDIT caret math — a NON-glyph consumer that the in-flight 0274
(EDIT tab-expansion) lane is editing. Folding it into the freetype-coupled
fontcore.h would pull freetype into user32.c and touch a file 0274 depends on.
So it stays the win32 seam's own pure copy; `fc_u8_next` carries the identical
logic for the glyph consumers. gdi32 keeps calling `__u8_next` in its text
loops (it already includes win32_internal.h). Flagged for the master to
optionally fold after 0274 merges.

## Gate

kernel 102/102 · browser sweep 35/35 (incl. os-term/os-gdi/os-user32 goldens,
none moved) · flake gate green (os-term stable 3/3 under load). No golden moved
→ byte-identity holds.
