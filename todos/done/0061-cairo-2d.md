# 0061 — Cairo: the modern C 2D vector API (adopt, don't invent)

- **Status**: done (2026-07-10) — cairo 1.18.4 + pixman 0.42.2 vendored
  (ONE one-line patch; the setjmp-value idiom and `#if 0` perl code became
  COMPILER fixes: assignment setjmp forms + C11 "other" pp-tokens, both
  test-first). `/bin/cairodemo` seeded (image v43, resizable, vector
  re-render on resize); acceptance = 14 UNMODIFIED upstream test-suite
  programs vs upstream reference PNGs, 9 pixel-EXACT. Tests:
  `tests/run.py --types cairo`, `tests/kernel/test_cairo_e2e.js`,
  `tests/browser/os-cairo.mjs`. Dev log `logs/2026-07-10/cairo-2d.md`.
  Follow-ups: `0079` (project dep dedup — the diamond-dep link errors
  found here), `0080` (PDF/SVG output surfaces — the subsetting machinery
  already compiles); the close also queued `0081` (test-infra overhaul —
  the ~20-min suite died twice with session teardown during this landing).
  Residue owned by 0064/0081: the full kernel suite + 15-file browser
  sweep did not complete this session (27/41 files green, no failures
  seen; os-cairo.mjs green; os-shell.mjs re-run owed after its
  MENU_ENTRIES change). The optional cairo-webgpu backend stays declined
  per this item's own plan (CPU-first grain; revisit only on demand).
- **Design**: `todos/WIN32.md` (windowing-vs-drawing split); this item

## Goal

Adopt **Cairo** as the platform's modern 2D vector drawing API for new C
apps — instead of inventing a Direct2D analog. Cairo is pure C, the stable
2D API under GTK/Pango/Inkscape/Poppler/old-Firefox, and its corpus is a
real testing oracle. Its **image backend is software rasterization into a
pixel buffer = our shm transport already**, so a Cairo port draws
correctly with near-zero backend invention; a `cairo-webgpu` backend is
the *optional* GPU upgrade, not a prerequisite. Rides the surface
protocol (image backend → shm) on the `0055` compositor.

## Why Cairo over the alternatives

- **NanoVG**: small, GPU-native, canvas-shaped — but itself an analog with
  a thin (demo) corpus. Weak on the "test against real programs" goal.
- **OpenVG**: C, but effectively dead.
- **Skia / Qt QPainter / AGG**: C++, out.
- **Direct2D/DirectWrite**: C++/COM, non-portable corpus — the thing we're
  declining to reinvent. (A *toolkit-backing subset* would be NanoVG-scale
  — SDF rounded-rects + a glyph atlas, ~a few thousand lines — but Cairo's
  corpus wins.)

Cairo wins on corpus + pure-C + pluggable backend.

## Plan

- Vendor Cairo (+ pixman) with a `bin.json` like other vendored libs; wire
  the **image backend** to an shm surface (trivial — already
  software-into-a-buffer). Text via freetype (Cairo's freetype font
  backend; harfbuzz/Pango reserved for complex scripts).
- A demo/port that draws vector content (gradients, curves, AA) to a
  window, composited by `0055` like any shm surface.
- Optional later: a `cairo-webgpu` backend (the GPU upgrade — real work,
  against Cairo's CPU-first grain; only if a GPU-2D app measurably needs
  it). Not required for correctness.

## Relationship to GDI (0057)

Parallel 2D APIs for different corpora: **GDI for ported Win32 apps, Cairo
for new / GTK-heritage C apps.** Both render CPU → shm → GPU-composite (the
DWM model). Not redundant (different app populations) — so no zombie path.

## Acceptance

- A Cairo vector demo renders correct headless (shm golden, AA tolerance)
  and in-browser. One real Cairo-using program compiles + runs.
