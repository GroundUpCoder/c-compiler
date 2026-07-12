# 0080 — Cairo: enable the PDF/SVG output surfaces (document export / printing)

- **Status**: deferred (mass-deferred 2026-07-12; was: open)
- **Design**: `vendor/cairo/README.md`; this file (follow-up from 0061)

## Goal

0061 vendored cairo with the image surface only, but the tarball's PDF/SVG
/PS surface sources are pure C and the font-subsetting + pdf-operators +
deflate-stream machinery they need is ALREADY compiling in
`vendor/cairo/lib.json` (it's in upstream's unconditional core list). The
missing pieces are small: add `cairo-pdf-surface.c`/`cairo-pdf-interchange.c`
(and/or `cairo-svg-surface.c`, `cairo-ps-surface.c`) plus their public
headers to the vendored set, flip `CAIRO_HAS_PDF_SURFACE`/`CAIRO_HAS_SVG_SURFACE`
in `src/cairo-features.h`, and re-run the suite.

That gives every app "print to PDF/SVG" — real document OUTPUT for the OS
(a `wmctl`-style `print` verb, or apps calling
`cairo_pdf_surface_create()` directly) — nearly free.

## Plan

- Copy the surface sources + `cairo-pdf.h`/`cairo-svg.h` from the pinned
  1.18.4 tarball (sha in `vendor/cairo/README.md`), extend lib.json +
  features header.
- Acceptance app or test: render the cairodemo scene to a PDF, assert the
  file parses (magic + xref) and embeds the subsetted font; an upstream
  test with a pdf ref if feasible.
- Wire a seeded demo use (e.g. `cairodemo pdf /root/out.pdf`).

## Acceptance

- A C program in-OS writes a valid PDF via cairo; `tests/run.py --types
  cairo` covers it; vendored-source delta documented in the README.
