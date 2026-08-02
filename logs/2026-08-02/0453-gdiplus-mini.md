# 0453 / #94 — gdiplus-mini: the flat GDI+ shim the image viewer runs on

**Branch** `0453-gdiplus-mini`, based on `origin/main` at `a054a3ff`.
Ticket #94 (`019fb314-461d-7651-89b9-34257ab20a88`), heavy, P1. Next link in the
chain is #95 (the shimgvw port); #93/0448 (libjpeg) was the prerequisite and
shipped in gucOS 217.

---

## The surface is DERIVED, and the count is 29, not 28

The ticket is emphatic that the scoping note's *"28 flat-API `Gdip*` functions"*
is a scope ESTIMATE, and that the ReactOS sources are the interface contract.
So the first thing this lane did was fetch them:

```
source   github.com/reactos/reactos  dll/win32/shimgvw
revision e3e58ac1aacc3a2eb361c1fcbcc0c632c2616782   (master @ 2026-06-30)
files    CMakeLists.txt anime.c comsup.c comsup.h loader.cpp resource.h
         shimgvw.c shimgvw.h shimgvw.rc shimgvw.spec util.c   (3,058 lines)
```

Two independent sanity checks that these are the right sources: `comsup.c` is
57 lines and `loader.cpp` is 283 — exactly the figures the scoping note quotes.
(The note's "2,786 lines total" is now 3,058; the file grew between the note's
read and this one. That is drift in the note, not a different codebase.)

Enumeration:

```
grep -ohE '\b(Gdip|Gdiplus)[A-Za-z0-9_]*' *.c *.cpp *.h | sort -u   =>  32
```

Three of those 32 are **not functions**, and each had to be looked at to know
that:

| match | what it really is |
|---|---|
| `Gdiplus` | the C++ namespace, `using namespace Gdiplus;` — loader.cpp:11 |
| `GdiplusStartupInput` | the struct type — shimgvw.c:1736 |
| `GdiplusVersion` | its field — shimgvw.c:1760 |

**32 − 3 = 29 flat functions.** All 29 are declared in
`os/win32/include/gdiplusflat.h` and implemented in `os/win32/gdiplus.c`.

**The note says 28. Expanding the note's OWN compressed groups also gives 29**
(4 lifecycle + 3 load + 4 query + 6 draw + 6 frames + 1 transform + 5
save/enumerate), so the note is short by one somewhere in its own arithmetic —
this header is not long by one. Worth stating plainly because the ticket asked
for exactly this comparison.

The 29, grouped as the header groups them:

- **lifecycle (4)** `GdiplusStartup` `GdiplusShutdown` `GdipDisposeImage` `GdipDeleteGraphics`
- **load (3)** `GdipLoadImageFromStream` `GdipLoadImageFromFile` `GdipCreateFromHDC`
- **query (4)** `GdipGetImageWidth` `GdipGetImageHeight` `GdipGetImageRawFormat` `GdipGetImageFlags`
- **draw (6)** `GdipDrawImageRectRect` `GdipSetSmoothingMode` `GdipSetInterpolationMode` `GdipCreateImageAttributes` `GdipSetImageAttributesWrapMode` `GdipDisposeImageAttributes`
- **frames (6)** `GdipImageGetFrameDimensionsCount` `GdipImageGetFrameDimensionsList` `GdipImageGetFrameCount` `GdipImageSelectActiveFrame` `GdipGetPropertyItemSize` `GdipGetPropertyItem`
- **transform (1)** `GdipImageRotateFlip`
- **save / enumerate (5)** `GdipSaveImageToFile` `GdipGetImageEncodersSize` `GdipGetImageEncoders` `GdipGetImageDecodersSize` `GdipGetImageDecoders`

The two names the ticket warned are unresolvable from the note
(`GdipSetImageAttributesWrapMode`, `GdipDisposeImageAttributes`) came out of
`shimgvw.c`'s draw block, where the note's `GdipCreateImageAttributes + WrapMode
+ Dispose` shorthand actually lives.

---

## TRAP 2 — how GIF/BMP got wired, and why the "(a) or (b)" was a false choice

The kickoff framed the decoder routing as a fork: **(a)** `lib.json` linkage
from the shim to `../netsurf/libnsgif/lib.json` and `../netsurf/libnsbmp/lib.json`,
or **(b)** promote those two to `packages/*.json` srclib packages beside
libpng/libjpeg.

**Both, because libpng already does both** — `vendor/libpng/lib.json` AND
`packages/libpng.json` exist and serve different consumers. The asymmetry the
kickoff measured is real, but it is not a fork; it is a *missing half*:

- `vendor/netsurf/libnsgif/lib.json` and `libnsbmp/lib.json` existed → the
  **bake path** just needed a `deps` edge. `os/win32/gdiplus.json` names all
  four decoder libs.
- No `packages/*` for them → the **in-OS `cc` path** would have dead-ended at
  `nsgif/...` / `nsbmp/...` for two of four formats while PNG and JPEG
  resolved. Added `packages/libnsgif.json` and `packages/libnsbmp.json`,
  mirroring `packages/libpng.json` line for line.

Doing only (a) would have shipped a shim whose in-OS story is "two formats
work, two produce undefined symbols" — the CPU-path-with-a-GPU-asterisk shape
CLAUDE.md rejects. Doing only (b) would leave the bake without a dependency
edge. So: (a) for the bake, (b) for the srclib, and they agree.

One real edit fell out of it: **`libnsgif`/`libnsbmp` had no `srcRoots`**, so
`__require_source("nsgif/gif.c")` had nowhere to resolve
(`unknown required source ... no source roots configured`). Added
`"srcRoots": {"nsgif": "src"}` / `{"nsbmp": "src"}` — the namespace belongs
with the library that owns it, the way libpng/zlib/libjpeg already declare
theirs. Confirmed exempt from the NetSurf patch record: those `lib.json` files
are repo-authored build metadata, `pristine.json` does not mention them, and
`netsurf-patch`'s own "a lib.json-only change is exempt" leg passes.

---

## Where the code lives, and why gdiplus is NOT in the base veneer

Three new components, not one:

| file | what | link set |
|---|---|---|
| `os/win32/include/objbase.h` + `os/win32/ole32.c` | COM-lite: GUID, `IStream` over an HGLOBAL, `OleInitialize` | **BASE veneer** (`lib.json`) |
| `os/win32/include/gdiplusflat.h` + `os/win32/gdiplus.c` | the 29 | **own component** (`gdiplus.json`) |
| `os/win32/gdiplusdemo.c` + `.json` | the acceptance app | deps `gdiplus.json` |

`ole32.c` is base because `IStream` and `OleInitialize` are generic, tiny, and
have no dependencies — a future port wanting a memory stream should not have to
link a JPEG library to get one.

`gdiplus.c` is deliberately **NOT** base. Adding it to `os/win32/lib.json`
would (via the §4.4 drift gate) force `windows.h` to require it, and then every
win32 app in the tree — winmine, notepad, calc, fileman — would compile and
link libpng + zlib + libjpeg + libnsgif + libnsbmp. It is the `menucore.json`
precedent: a split component whose own header carries its own require block.

The **require-drift gate** (`os/os-common.js` `win32RequireDriftErrors`) grew
the matching pair, so this split is guarded the same way the others are:

- `gdiplusflat.h`'s require set == `gdiplus.json` sources (§4.1)
- `gdiplus.c`'s require set == the four decoder `lib.json`s' sources, as
  `png/…` `z/…` `jpeg/…` `nsgif/…` `nsbmp/…` (§4.2 — vendor knowledge stays
  with its consumer, the `gdi32.c`/freetype rule)
- `packages/win32.json` must SHIP `gdiplus.c` and `ole32.c` (the payload half,
  extended to `veneer ∪ gdiplus`)

That last one is TRAP 3 made permanent: a new `.c` under `os/win32/` is
invisible to the in-OS `cc` until `packages/win32.json` names it, while a new
header under `include/` is picked up automatically by the `tree` mapping. The
gate now fails rather than letting that asymmetry produce a green host build
and a link error in-OS.

---

## Design decisions worth the ink

**One pixel word, chosen so nothing swizzles.** gdi32's bitmap word is
`R | G<<8 | B<<16 | A<<24`. Every decoder was configured to produce exactly
that: libpng `PNG_FORMAT_RGBA`, libnsgif `NSGIF_BITMAP_FMT_R8G8B8A8`, libjpeg
`JCS_RGB` with alpha filled, and libnsbmp — which writes
`data[2] | data[1]<<8 | data[0]<<16 | 0xFF<<24` natively, i.e. already ours.
So `CreateBitmap(w, h, 1, 32, pixels)` is a memcpy and the draw path has no
conversion step at all.

**The draw goes through a private offscreen bitmap, which also dodges TRAP 1.**
`GdipDrawImageRectRect` builds a memory DC over a COPY of the active frame and
`StretchBlt`s from it. gdi32 refuses a blit *within one surface*
(`src->bits == dst->bits`); because the source is always a fresh bitmap, that
wall is unreachable by construction rather than by luck.

**RotateFlip is a pixel loop, and the test says why.** The other StretchBlt
wall is non-positive extents — gdi32 has no mirroring path. A horizontal flip
expressed as a negative extent would hit it. `GdipImageRotateFlip` therefore
rotates and mirrors by hand, over **every frame**, not just the active one (an
animation that turned one frame would tear on the next tick). The
`flipx_pixels` leg is the one that would fail if someone later "optimised" this
into a mirrored blit.

**Nearest is the mode, and a request for better is recorded.** jku's scoping
reply accepted nearest first. `GdipSetInterpolationMode` still STORES the mode
(it is real state), but the first draw under a non-nearest mode emits one
`win32: unsupported ... (drawn NEAREST — 0453 accepted scope)` line naming what
was asked for. shimgvw asks for `InterpolationModeHighQualityBilinear` at any
non-multiple-of-100 zoom, so this will fire in the viewer — by design, and
audibly.

**`GdipSetSmoothingMode` is honestly inert.** Smoothing governs anti-aliasing
of VECTOR primitives, and this shim draws no vectors. Storing it and returning
`Ok` is a complete implementation of the semantic that exists here, not a stub.
Said so at the declaration so nobody has to re-derive it.

**The codec tables are a promise, so the encoder list is short.** shimgvw drives
its Save-As filter and its folder scan straight off `GdipGetImageEncoders` /
`GdipGetImageDecoders`. Decoders: BMP, JPEG, GIF, PNG. Encoders: **BMP and PNG
only** — the two `GdipSaveImageToFile` can really write (plan step 4). Listing
JPEG there would be precisely the silent-success failure arm 2 forbids. The
real CLSIDs and format GUIDs are used, so an id crossing this boundary still
means what it means on Windows.

**The GIF loop count needed unwinding.** libnsgif normalises the NETSCAPE
"repeat N more times" byte into a "play N+1 times" count and defaults it to 1
when the extension is absent. GDI+ reports the file's own number, and has no
`PropertyTagLoopCount` at all when there is no extension. So: `loop_max == 1`
→ property absent, `loop_max == 0` → 0 (forever), otherwise `loop_max - 1`.
Caught by the fixture, whose NETSCAPE value is 3 — the first run asserted 3 and
got 4.

**`GdipImageSelectActiveFrame` must FAIL on the wrong dimension.** shimgvw's
`anime.c` probes `FrameDimensionTime` and falls back to `FrameDimensionPage`
*on the status*. A shim that accepted both would break animated GIF detection
in a way no pixel test would notice. There is a leg for it.

---

## What the alpha question turned out to be

The kickoff said: if the derived surface genuinely needs alpha compositing,
STOP and say so rather than quietly implement a private AlphaBlend. **It does
not need it to function, but it does show.**

shimgvw paints a checkerboard behind an image whose `ImageFlags` report alpha,
then draws the image over it expecting GDI+ to composite. Our blit is SRCCOPY,
so a translucent PNG lands opaque and the checkerboard never shows through.
That is a fidelity gap, not a capability gap: the viewer runs, the pixels are
right except where they should have been blended.

No private AlphaBlend was written. Instead:

- `GdipGetImageFlags` reports `HasAlpha` / `HasTranslucent` **honestly**, so the
  viewer's own logic still behaves;
- the first draw of an alpha image emits `win32: unsupported ... blit is
  SRCCOPY (no compositing; ticket #285)`;
- **L73** in `todos/LIABILITIES.md` funds it against **#285** (C6 — AlphaBlend
  + TransparentBlt + SetStretchBltMode), which is open and is exactly the
  ticket that owns the primitive.

This also settles the kickoff's soft-`after` question in the affirmative: #285
is a fidelity dependency, not a capability one, and #94 did not need to wait.

---

## Two more gaps, filed rather than left as prose — ticket #379

Both are loud refusals in code, both are real work #95 will meet, so both got a
ticket **and** a register entry in this commit (the enrolment rule):

- **L74 / ICO-CUR decode.** `decode_memory` dispatches by SIGNATURE, never by
  filename — a viewer must not be fooled by a `.png` that is really a JPEG.
  ICO is not among the four and returns a loud `UnknownImageFormat`. It matters
  because shimgvw's `loader.cpp` explicitly rewrites a `.cur` header into an
  `.ico` and reorders the directory so "GDI+ will return the first image": it
  hands the container straight through. libnsbmp's `ico_*` is already linked,
  so this is absent decode, not an absent decoder. Left out because the ticket
  enumerates four formats and a half-tested fifth is worse than a refusal.
- **L75 / JPEG encode.** Consequence of the short encoder list above:
  `Preview_pSaveImage` looks the image's own `rawFormat` up in that list, so
  **"rotate clockwise and save" will refuse on a JPEG** — the commonest thing
  anyone does in an image viewer. Scoped out by plan step 4, not by oversight.

---

## Testing

`os/win32/gdiplusdemo.c` is the acceptance app on the `gdidemo selftest`
pattern: headless, memory DCs, `printf`, **107 checks**. It is baked to
`/usr/bin/gdiplusdemo` (no Demos menu entry — it has no window).

**The fixtures are foreign.** PNG, BMP, GIF and JPEG are byte arrays written by
Pillow 12.2.0, not by this tree's own encoders, so a decode assert cannot be
satisfied by a self-consistent round trip. Regenerate with:

```python
from PIL import Image, ImageSequence; import io
# PNG 4x2 RGBA (one 50%-alpha pixel, one fully transparent)
px = [(255,0,0,255),(0,255,0,128),(0,0,255,255),(255,255,255,0),
      (10,20,30,255),(40,50,60,255),(70,80,90,255),(100,110,120,255)]
im = Image.new('RGBA',(4,2)); im.putdata(px)
b = io.BytesIO(); im.save(b, format='PNG')            # -> k_png
# BMP 4x2 24bpp bottom-up
im2 = Image.new('RGB',(4,2)); im2.putdata([(255,0,0),(0,255,0),(0,0,255),(255,255,255),
                                           (1,2,3),(4,5,6),(7,8,9),(250,240,230)])
b = io.BytesIO(); im2.save(b, format='BMP')           # -> k_bmp
# GIF89a 4x2, 2 frames, delays 10cs/20cs, NETSCAPE loop 3, frame 1 local palette
pal = [255,0,0, 0,255,0, 0,0,255, 255,255,255] + [0]*(256*3-12)
f0 = Image.new('P',(4,2)); f0.putpalette(pal); f0.putdata([0,1,2,3, 3,2,1,0])
f1 = Image.new('P',(4,2)); f1.putpalette(pal); f1.putdata([1,1,1,1, 2,2,2,2])
b = io.BytesIO(); f0.save(b, format='GIF', save_all=True, append_images=[f1],
                          duration=[100,200], loop=3, disposal=2)   # -> k_gif
# JPEG 8x8 q100 no subsampling: rows 0-3 (200,30,40), rows 4-7 (20,180,90)
```

**Can-fail controls (arm 3).** Every format has one, and one of them had to be
made harsher: the JPEG control originally XOR'd the tail, and **libjpeg treated
that as a warning and returned pixels anyway** (`Corrupt JPEG data: 29
extraneous bytes before marker 0xd9`) — a vacuous control that passed for the
wrong reason. It now truncates to a third and garbles what is left, the same
recipe `test_cc_libjpeg_e2e.js` uses, which cuts inside the Huffman tables and
is a real error. Left as a note because the next person to write a libjpeg
negative test will hit exactly this.

**Arm 4 — the non-1:1 draw.** A 4x2 image into an 8x4 destination rect, all 32
destination pixels asserted. **The mode under test is NEAREST**: at exactly 2x
each source pixel becomes a 2x2 block, which is correct-by-definition for
nearest and would NOT hold for bilinear. Two more legs: a sub-rectangle source
at 2x (proves the source ORIGIN is honoured, not just the extent), and a
`-0.5f` source origin — the value shimgvw literally passes as its interpolation
nudge — which must round back onto pixel 0 rather than off the image.

**`tests/kernel/test_gdiplus_e2e.js`** drives it in a booted OS and adds four
things the in-OS selftest cannot check about itself:

1. **the total is PINNED at 107.** A selftest that silently loses legs still
   prints `PASS`; pinning is what makes a shrink visible. Bump it with the
   source.
2. **named legs**, so `PASS` cannot come from a run that skipped the arms most
   worth faking.
3. **the diagnostic reached stderr.** The selftest proves the STATUS is an
   error; this proves `WIN32_UNSUPPORTED` actually printed. Those are the two
   halves of fail-loud and only one of them is visible in-process.
4. **the save path touched the real filesystem** — the files are `ls -l`'d from
   the shell, so an encoder that "succeeded" without writing bytes is caught.

Suite registry: **146 → 147** kernel tests.

---

## Drift found on arrival

- `main` had moved past the kickoff's stated tip: **`f374243b` → `a054a3ff`**
  (the #363+#358 term Settings commit landed in between). Branched from live
  `origin/main`.
- Kickoff coordinates that were exact: `StretchBlt` decl `windows.h:511`, defn
  `gdi32.c:1647`, both refusal walls at `:1650` and `:1657`,
  `tests/kernel/run.js` registry at `:38`, `test_cc_libjpeg_e2e.js` registered
  at `:171`, `gdidemo.c:275`'s 2x StretchBlt assert. No gdiplus anywhere. All
  confirmed.
- Self-inflicted, recorded so the next reader does not repeat it: `objbase.h`
  first defined its own `FILETIME`, which **already exists at
  `windows.h:1493`**, and because `ole32.c` joined the base veneer that
  redefinition broke the compile of *every* win32 port at once
  (`tools/win32ports.js --check` named all twelve). `ULARGE_INTEGER` genuinely
  was absent and is the one COM primitive `objbase.h` adds.
