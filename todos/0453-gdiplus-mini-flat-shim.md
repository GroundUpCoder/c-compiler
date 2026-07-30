# 0453 — gdiplus-mini: flat-API GDI+ shim for the shimgvw viewer

- **Status**: open
- **Design**: the gucOS image-viewer follow-up scoping pass,
  `~/git/meta/gucos/notes/image-viewer-followup-gdiplus-cpp.md` §2 (and the
  first-round report `image-viewer-scoping-email.md`). Those reports are the
  authority for *why*; this ticket is the authority for *what*.
- **Provenance**: filed 2026-07-30 by @master (cont-220) on jku's direct
  ruling, given as an email reply to the follow-up scoping report. jku's words:
  *"That plan sounds good. The lower tier stuff (ie C++ etc) let's queue it as
  active but put them as P3. The libjpg vendoring should be higher priority
  since it's more bounded and with clear benefits."* Together with his approval
  of the viewer path: **gdiplus-mini + a shimgvw port IS the gucOS image
  viewer; the roll-our-own viewer app is SKIPPED.**

## 🔴 THE SCOPING NOTE'S "28 FUNCTIONS" IS A SCOPE ESTIMATE, NOT AN INTERFACE CONTRACT

**Do not take the function list from the scoping note. Derive it from the
`shimgvw` sources.** The note's §2 states *"the whole viewer uses 28 distinct
flat-API `Gdip*` functions"* and then lists them in a **compressed** notation
that does not spell out 28 literal symbols. Measured: a unique-name grep over
that note yields **19** names, not 28, because entries collapse several
functions into one string —

- `GdipGetImageWidth/Height/RawFormat/Flags` is **four** functions written as one name.
- `GdipImageGetFrameDimensionsList/Count`, `GdipGetPropertyItem(Size)`,
  `GdipGetImageEncoders(Size)`, `GdipGetImageDecoders(Size)` are **two** each.
- `GdipCreateImageAttributes + WrapMode + Dispose` is **not a resolvable symbol
  at all** — the real names (`GdipSetImageAttributesWrapMode`,
  `GdipDisposeImageAttributes`) must be recovered from the source.

⇒ **The source of truth is the ReactOS `shimgvw` source itself.** Enumerate the
`Gdip*`/`Gdiplus*` call sites there, **print the derived count**, and state it
in your report. If your count is not 28, say so and give the list — the note's
number is an estimate made by a different reader and it may be off by a few.
This is (EI): name the source, derive the list, print the count so a shrink or
a growth is visible.

## Goal

A **gdiplus-mini** shim: exactly the flat GDI+ surface the `shimgvw` viewer
calls, implemented over what the tree already has. It is the decode/draw engine
that makes ticket **0454** (the viewer app) possible.

**Non-goal:** a general GDI+ implementation. Implement the measured surface and
nothing more; anything outside it must **fail loud**, never silently no-op.

## Scope — measured against `main` at filing time

🔴 **`kernel.js` and `host.js` are at the REPO ROOT. `os/kernel.js` and
`os/host.js` DO NOT EXIST.** (Neither is touched by this ticket.)

**Verified present — build on these, do not re-create them:**
- Decoders already in-tree: `vendor/libpng/`, plus NetSurf's `libnsgif` and
  `libnsbmp`. **JPEG decode arrives with 0448** (this ticket is blocked on it).
- `os/win32/gdi32.c` / `gdi32w.c` — the GDI layer the draw path lands on.
- `os/win32/advapi32.c` has **real** registry calls (measured: `RegOpenKeyExW`
  2 hits, `RegQueryValueExW` 1, `RegSetValueExW` 1, `RegCloseKey` 6).

**Verified absent — genuinely new work:**
- No `gdiplus` source, header, or package anywhere in the tree.
- **There is no ReactOS checkout in this repo** (`find -iname "*reactos*"`
  returns nothing). You must fetch the `shimgvw` sources to enumerate the
  surface. Record where you got them and the revision.

## Plan

1. **Derive the surface** from the `shimgvw` sources (see the 🔴 section above).
   Print the count and the list.
2. **Decode**: route to in-tree `libpng` / `libnsgif` / `libnsbmp` / `libjpeg`
   (0448) behind a single internal decode entry point.
3. **Draw**: `GdipDrawImageRectRect` over **`StretchBlt`**, **nearest-neighbour
   first** (explicitly accepted by jku's scoping reply — quality is not the bar
   for v1). If interpolation fidelity later matters, add a bilinear path in
   **one** place in the shim.
4. **Encode / enumerate**: `GdipSaveImageToFile` via **libpng and BMP** encode.
   `GdipGetImageEncoders(Size)` / `GdipGetImageDecoders(Size)` return **static**
   tables.
5. **Transform**: `GdipImageRotateFlip` as a pixel loop.
6. **Frames** (animated GIF): the frame-dimension / frame-count / select-active-
   frame / property-item calls, which is how the viewer reads GIF frame delays.
7. **COM-lite**: an `IStream` over a memory buffer (`CreateStreamOnHGlobal`)
   plus a **no-op `OleInitialize`**. `shimgvw`'s own `comsup.c` is 57 lines, so
   keep this layer correspondingly thin.

## Acceptance

🔴 **Every arm below is required. Do not close this ticket with an arm skipped
and unmentioned.**

1. **The surface is DERIVED, not copied.** Your report names where the `shimgvw`
   sources came from (and their revision), lists the `Gdip*` symbols the viewer
   actually calls, and **prints the derived count**. If it differs from the
   note's 28, say so explicitly.
2. **Every derived symbol is either implemented or fails loud.** No silent
   no-op and no stub that returns success without doing the work. A caller must
   never be able to mistake "not implemented" for "succeeded".
3. **Decode is proven per format** — PNG, GIF, BMP and **JPEG** (via 0448) each
   decode through the shim in a test, with a **positive control**: the test must
   also demonstrate it can FAIL (feed a corrupt/truncated buffer and assert the
   error path), so a vacuously-passing decode test is impossible.
4. **The draw path is proven at a non-1:1 scale** — a stretched blit, asserted
   against expected pixels. Nearest-neighbour output is correct-by-definition
   here; state that the mode under test is nearest.
5. **A registered test.** Add the test to the suite that actually runs it and
   **give the new total** — if you add a test file, say so and state the count
   before and after. `tests/kernel/run.js` hand-enumerates its registry, so a
   new file there is invisible until registered.
6. **Build-to-the-goal:** implement the measured surface cleanly and generally.
   "Only the viewer needs it" is **not** a reason to special-case a code path.

## Known scope caveat — record it, do not act on it

The scoping pass measured that **ReactOS `mspaint` does NOT use GDI+** (its
import libs are plain `gdi32`/`comctl32`/etc.). So **`shimgvw` is currently the
only known consumer** of this shim, and the reuse argument for gdiplus-mini
rests on *future* GDI+ ports rather than on a second consumer today. jku was
told this caveat and approved the path anyway. **Do not widen the surface
speculatively for imagined future consumers** — that is the opposite of what
this note licenses.
