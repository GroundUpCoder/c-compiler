# win32: gdi32 drawing subset (todos/0057)

First slice of the Win32 platform (`todos/WIN32.md`): the GDI drawing
layer, landed as `os/win32/` — an app-side lib.json library, exactly the
Wine/Cygwin veneer model the design doc calls for. No kernel, host.js, or
compiler.js change; the library rides the existing pieces (SDL surface =
shm present, vendored freetype = text, the cc driver's project builds =
linking).

## Shape

- **`os/win32/include/windows.h`** — windef types (ILP32), the gdi32 API,
  rect utils, `MulDiv`, and `*A` aliases so ported ANSI sources compile.
  One underlying `__GDIOBJ` type behind HPEN/HBRUSH/HFONT/HBITMAP keeps
  `SelectObject` cast-free in plain C.
- **`os/win32/gdi32.c`** — the CPU rasterizer. An HDC wraps either a
  window's SDL surface pixels (screen DC) or the selected HBITMAP
  (memory DC; created with a Windows-style owned 1x1 default bitmap).
  Screen present = `SDL_UpdateWindowSurface` at `ReleaseDC`/`EndPaint` —
  the DWM redirection model over our existing shm mailbox, no new
  transport.
- **`os/win32/lib.json`** deps on `vendor/freetype/lib.json`; the include
  order is load-bearing: `vendor/freetype/demo` must precede
  `vendor/freetype/include` because demo's `ft2build.h` shadows the real
  one to select `myftoption.h`/`myftmodule.h` (the minimal-module build).
  Getting that backwards links 17 missing driver classes.

## Decisions worth remembering

- **HWND is a 0057 scaffold** (`__gdi_bind_hwnd(sdl_window)`), openly
  temporary: 0058's user32 owns the real HWND tree, and `BeginPaint`/
  `GetClientRect` were written against the opaque handle so 0058 can swap
  the innards without touching drawing code.
- **COLORREF passes through**: 0x00BBGGRR has R in the low byte — so does
  our RGBA surface format. Pen/brush colors are `cr | 0xFF000000`;
  only DIBs (B,G,R,X order) swizzle.
- **Alpha discipline**: every write forces A=0xFF. The compositor samples
  alpha; a fresh `CreateCompatibleBitmap` is opaque black, not zeros —
  0-alpha pixels blitted to a surface would show the desktop through the
  window.
- **Real GDI edge semantics, tested**: right/bottom-exclusive figures,
  `LineTo` excluding its endpoint (and updating the current position),
  `DeleteObject` refusing a bitmap that's still selected, `GetPixel`
  returning `CLR_INVALID` outside bounds *or clip*, stock objects
  delete-as-no-op. These are the details ported code trips on; the
  selftest pins each one.
- **ROP2 all 16, ROP3 the useful subset** (SRCCOPY family + PAT ops +
  BLACKNESS/WHITENESS/DSTINVERT). `BitBlt` stages the source region when
  src and dst share a buffer, so overlapping self-blits behave like
  memmove.
- **Ellipse/RoundRect outline via span banding**: per-row spans (float
  midpoint math), boundary = span(y) minus the intersection of the
  neighbors' spans. One shared `draw_span_shape` renderer; outlines are
  1px regardless of pen width (recorded simplification).
- **Fonts**: one face per HFONT (`FT_New_Face` per object, lazy), glyph
  cache per font like term's, ASCII 32..126 with '?' fallback,
  `/etc/fonts/mono.ttf` → `/usr/share/fonts/mono.ttf`. `faceName` is
  ignored — one font in the image. Negative `lfHeight` = pixel em size;
  positive scales by the face's font-unit line height.
- **Leak discipline is a first-class API**: `__gdi_object_count()` /
  `__gdi_dc_count()` — the acceptance criterion ("repeated paint cycles
  free every GDI object") is asserted by looping 200 create/select/draw/
  delete cycles and requiring both counters back at baseline. The demo
  repaints (create+delete everything) every frame, so the browser run
  exercises it continuously too.

## Deliberate omissions (grow under 0060's missing-symbol log)

No CreateDIBSection (GetDIBits/SetDIBits copy+swizzle instead — a live
BGRA bits pointer would force dual-format storage through every blit), no
SaveDC/RestoreDC, no palettes/world transforms, regions are the DC clip
rect only (`SelectClipRgn(NULL)` = reset), pens are square nibs, dashed
styles draw solid, no font bold/italic synthesis (ftsynth.c isn't in the
freetype lib build). All listed in gdi32.c's header comment.

## Tests

- `tests/kernel/test_gdi32_e2e.js`: boots the OS headless, runs
  `gdidemo selftest` (~40 in-OS memory-DC asserts + the leak check), then
  the windowed scene: `wmctl list` (title/480x360/fixed), `wmctl shot`
  probed at exact scene coordinates (the coordinates in the test mirror
  `draw_scene` — change together), and **two shots a second apart must be
  byte-identical** (the app repaints every frame; the rasterizer is
  deterministic — that's the "bit-exact headless" acceptance without a
  brittle stored blob).
- `tests/browser/os-gdi.mjs`: same scene probed through the real WebGPU
  compositor on VT2, close-box quit, shell survives.

## Ripple: the Start menu grew a row

Seeding `/usr/share/menu/gdidemo` makes the sorted menu **8 entries**
(doom gameboy gdidemo gpubox quake snake term winbox): 150x168 parked at
taskbar−168, winbox at index 7 (click row y=154). Two tests hardcoded the
7-entry geometry and failed exactly as expected —
`tests/kernel/test_wm_service_e2e.js` (the entry click launched *term*,
cascading 4 failures) and `tests/browser/os-shell.mjs`. Both updated;
anyone adding a menu entry pays this toll again (the geometry comes from
wm.c's `MENU_ENTRY_H 20` / `MENU_PAD 4`).

Image v33 → v34 (new seeded binary + menu entry), `os/os-system.img`
rebaked. Suites this session: kernel all files PASS (incl. the new e2e
and the fixed wm_service), blockfs 12/12, unit 699/0/3, browser: the new
os-gdi + the full 10-file sweep green (os-boots flaked once on its very
first post-rebake run, clean on re-run; every other file passed first
try).
