# #657 — PNG replaces PPM as the screenshot substrate, end to end

`wmctl shot` / `wmctl thumb` now encode RGBA PNG through the vendored
libpng+zlib, and every active consumer in the estate decodes PNG. This note
records why the original shortcut existed, what the new contract is, what was
deliberately NOT changed, and how the migration was mechanised.

## The original shortcut, and why it outlived its reason

`shot_to_ppm()` (os/wmctl.c) took the WMP `R_SHOT` payload — `sid, w, h`, then
`w*h*4` straight-alpha RGBA bytes — and wrote a P6 PPM: an ASCII header plus
three bytes per pixel, **dropping the alpha channel**.

P6 is trivially writable with `fprintf` + `fwrite` and needs no library. That
was the whole appeal. It was never a platform constraint: **libpng and zlib
were already vendored before `wmctl shot` was introduced**, and `os/deck/deck.c`
was already writing real PNGs with `png_image_write_to_file` at the time.

The cost compounded quietly. An uncompressed interchange format with a
fixed-size header invites two habits, and the estate acquired both:

* **fixed byte offsets.** `tail -c +$((17 + (y*1024 + x)*3)) shot.ppm | head -c 3`
  became the idiom for "read one pixel", with the `17` hand-derived from
  `"P6\n1024 768\n255\n"`. Three test files did their pixel assertions this way
  entirely inside the shell.
* **per-file decoders.** Nineteen kernel e2es carried their own
  `parsePPM`/`parsePpms`/`parsePpm(b64)` — near-identical, independently
  drifted, none shared.

So the format was load-bearing in ~50 files, and the thing a human or a `gcode`
agent actually wanted to look at — a screenshot — needed host-side conversion
before it could be opened.

## The new contract

`shot_to_png()` writes what the kernel handed it:

* **Alpha is carried verbatim.** The payload's `a` bytes go straight into a
  `PNG_FORMAT_RGBA` image. A `SDL_WINDOW_TRANSPARENT` surface's per-surface shot
  keeps its `a=128`; screen composites and thumbnails carry `a=255` because
  `wmScreenshotScreen`/`wmThumbnail` write 255 on every path they synthesise
  (kernel.js). **The encoder is not opinionated about alpha** — that is the
  point, and it is what the three-legged test in `test_wm_service_e2e.js`
  asserts: 128 survives on the transparent surface, 255 survives on its opaque
  border, 255 on the screen composite.
* **Crop is a window into the buffer, not a copy.** `row_stride` stays the FULL
  surface width and the base pointer is offset to `(cy, cx)`, so `#173`'s
  region crop costs nothing and the reply still carries the whole surface.
* **Failure is loud and leaves nothing.** A failed encode, a short write, a
  failed `fclose`, or a `ferror` on the stream all fail the command, print
  libpng's message (or `strerror`), and `unlink` the output. A truncated PNG
  that reads as success is the exact hazard a compressed format introduces
  relative to PPM, so it is closed explicitly.
* **Determinism is preserved.** libpng's settings here are fixed, so equal
  pixels produce equal bytes. That is what keeps `cmp -s shot1.png shot2.png`
  valid as a settle/animation predicate — several tests depend on it and were
  left in-shell for that reason.

`/usr/bin/wmctl` moves from a bare `"c"` entry to a project entry
(`os/wmctl.json`) depending on `vendor/libpng/lib.json`, which already depends
on zlib. No PNG or deflate code is duplicated and nothing shells out to a
converter. Image version 257 → 258.

## The host side: one decoder, not nineteen

`tests/lib/png.js` was previously an *encoder* plus a P6 reader (it existed to
turn PPMs into viewable PNGs). It is now the codec:

* `parsePng(buf, off)` → `{ w, h, rgba, px(x,y), next }`. Colour types 2 and 6,
  8-bit, non-interlaced — exactly what the estate's writers emit — and it
  **throws** on anything else rather than decoding to a quiet zero. All five
  scanline filters are implemented because libpng picks per row.
* `next` is the offset past `IEND`, so the concatenated-`cat`-back streams the
  e2es use walk by re-calling `parsePng(buf, p.next)` — the same shape the old
  P6 walkers had.
* `px(x,y)` throws out of range. A pixel assert must never read `undefined`.
* `parseB64Png` for the `base64 /root/shot.png` cat-back idiom.
* `tests/kernel/lib/drive.js` grows `readShots(tmp, {...})`, so the six-line
  BlockFS-readback boilerplate that had been copy-pasted into seven files is
  now one function that throws (naming the path) when a shot the test believes
  it took is absent or undecodable.

`tests/host/test_png_helper.js` guards it, and its **positive controls are the
substance**: the filter legs apply all five PNG filters FORWARD from the spec
text — independently of the decoder's inverse — and a one-byte pixel change in
an otherwise identical image must be DETECTED. Breaking `px()` to return a
constant turns that leg red ("tampered pixel compared equal — the helper proves
nothing"); truncation, a palette image and a bad filter byte must each throw.

## Migration mechanics, and where judgement was needed

Most of the ~50 files were mechanical: the local P6 walker became a
`parsePng`-backed `parseShot`, `.data`/`.buf` became `.rgba`, stride 3 became
stride 4, `.end` became `.next`, `.ppm` became `.png`. **Every pixel predicate,
threshold, tolerance, histogram bound, colour set and dimension check was left
exactly as it was** — the migration is not allowed to buy green by weakening an
assertion.

Three cases needed a real decision:

1. **Fixed-offset shell probes** (`test_overview`, `test_snap`, `test_saver`).
   A compressed image has no byte offset per pixel, so these could not stay in
   the shell. They moved host-side onto the decoded image with the SAME
   coordinates and SAME expected RGB. This is a strengthening as well as a
   port: a mismatch now prints the actual value instead of failing a silent
   `cmp`. `test_overview`'s eight `pixEq()` probes became recorded expectations
   checked in one host-side pass.
2. **Byte-level frame compares** (`test_sameboy` animation/palette diff,
   `test_gdi32` idempotent-repaint). These compared raw stream slices; they now
   compare decoded RGBA. Same predicate, on uncompressed pixels.
3. **`"shot is a P6 frame"` magic-byte checks** (four files). Replaced with a
   full decode. This is strictly stronger — `parsePng` validates that every
   scanline is present, where matching two header bytes did not.

`notes/run-minesweeper-demo.mjs` is worth calling out. Its GPU-transport probe
was `tail -c +16 gpu.ppm | tr -d '\000' | wc -c` — "zero non-NUL bytes ⇔ an
all-black shot ⇔ the shm SAB was never touched". A black PNG still compresses
to non-zero bytes, so that trick does not merely need porting, it becomes
**silently wrong**. It now reads the shot out base64 and counts non-black
PIXELS host-side: the same predicate, on decoded pixels.

`tools/os-drive-headless.mjs` loses its PPM tempfile and its host-side
conversion entirely. `shot()` writes the bytes the OS produced **verbatim**
(after a validating decode), and the raw `.ppm` output option is gone — a
screenshot a human or an agent asks for is PNG from the source, with no
re-encode hop in between.

## What was deliberately NOT changed

**Legacy PBM/PGM/PPM *input* support stays.** It is a separate import-policy
question and this ticket does not decide it:

* `os/wm.c`'s `DK_IMAGE` extension table classifies `.ppm`/`.pgm`/`.pbm` (with
  png/bmp/gif) so a desktop file of that type gets the image glyph. Untouched.
* `tests/kernel/test_desk_icons_e2e.js` keeps its `photo.ppm` desktop fixture,
  which is what proves that table. It is a file named `.ppm` containing the
  byte `x` — not a screenshot, and not a checked-in image.
* `vendor/magicpoint`'s `image/pbm.c` PBM/PGM/PPM loader is untouched, as are
  libjpeg's and FreeType's own Netpbm facilities.

Historical logs and `todos/done/` records keep their PPM references; they are
accurate accounts of what was true when written.

## Census (2026-08-11)

Command:

```
rg -n -a -i --hidden -g'!.git' -g'!node_modules' -g'!*.img' '\b(ppm|pbm|pgm)\b' .
```

125 hits, all classified:

| Class | Where |
|---|---|
| Vendored legacy **input** / third-party facility | `vendor/magicpoint/image/*` (26), `vendor/libpng/pngget.c` (9), `vendor/libjpeg/jconfig.h`, `vendor/freetype/.../ftobjs.c` (Netpbm debug dump), `vendor/netsurf/libnsfb/include/libnsfb.h` |
| **Unrelated acronym** | `vendor/quake/**` (19 — "PGM" is a developer's initials in comments), `vendor/punes/.../pnp_vendor.h` (PNP vendor IDs), `vendor/cpython/Lib/stringprep.py` (U+33D9 SQUARE PPM), `vendor/busybox/.../bbunzip.c` (PPM = prediction-by-partial-matching), binary blobs (`pak0.pak`, riscv32 images, a TTF) |
| Vendored MIME tables | `vendor/cpython/Lib/mimetypes.py`, `.../email/mime/image.py` |
| **Legacy input, ours, deliberately retained** | `os/wm.c` DK_IMAGE table (2), `tests/kernel/test_desk_icons_e2e.js` (3), `CLAUDE.md:608` (MagicPoint's input formats) |
| **Historical** doc/log/record | `logs/**` (20), `todos/done/**` (8) |
| Backlog doc describing an upstream program's own output | `todos/CPP-LADDER-PROPOSAL.md` (tinyraytracer writes PPM) |
| Comment naming the format this ticket removed | `tests/kernel/test_wm_service_e2e.js:403` |
| **Defect** | none |

`git ls-files | rg -i '\.(ppm|pbm|pgm)$'` → **0** checked-in fixtures (the same
command for `.png` returns 145, so the zero is a measurement and not a broken
pipeline).

## Instruments that lie, for whoever migrates something like this next

* BSD `grep` calls several of these files binary and prints a confident `0` —
  always pass `-a`.
* `grep -c` **exits 1 on a zero count**, which silently aborts an `&&` chain.
* Every "no remaining X" claim above was run a second time against a string
  known to be present. A zero from an unproven command is not evidence.
