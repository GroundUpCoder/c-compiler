# 0275 — kernel-C text service: FreeType label rasterizer replaces compositor Canvas2D text

- **Status**: open (user-directed 2026-07-22 — the direction is settled, do
  not re-litigate; from the host-borrowed-shortcut audit,
  `logs/2026-07-22/host-borrow-audit.md`)
- **Design**: this file (promote to a topic doc if the blob grows)
- **Difficulty**: heavy

## Goal

The LAST text the OS presents that our own stack doesn't rasterize is the
compositor's label text: window title-bar captions, the close-box `'x'`, and
the Exposé cell captions are drawn by the BROWSER's text engine —
`os/compositor.js` `labelFor()` (~342–379) uses a throwaway 2D
OffscreenCanvas with `'bold 20px sans-serif'`, `measureText` + `fillText`
(maxWidth SQUISH on overflow), then uploads the canvas as a texture. Call
sites: compositor.js:437 (Exposé captions), :685 (close `'x'`), :687 (title
text). Everything else (wm.c chrome, menucore, term, gdi32) went FreeType in
the Unicode phases; this seam predates them and was carved out as "a texture
SOURCE, not scene assembly" (logs/2026-07-09/webgpu-mvu-direction.md) — that
carve-out is REJECTED: the browser is the hardware, not a co-renderer.

**The settled direction** (user, near-verbatim): compile a small
FreeType-based label rasterizer to wasm **with our own compiler**, loaded by
the kernel worker as a **kernel-side service blob**, and have
`labelFor()` call it instead of canvas `fillText`. "It makes sense for a
piece of the kernel to be written in C like userspace stuff. For now we
would just do text rendering, but in the future that kernel wasm blob may
grow and have additional functionality." So: design it as a GROWABLE
kernel-C blob with a clean init/call ABI from kernel JS — text rendering is
its first capability, not its shape.

## Plan

- **The blob**: `os/ksvc/` (kernel service) — `ksvc.c` + a `bin.json`
  linking vendored freetype, built at bake time like any other manifest
  entry and seeded at `/usr/lib/ksvc.wasm` (system section; bump
  `image.json` version). No process, no pcb: kernel-worker.js reads the
  bytes through `kfs` after mount and instantiates it IN the kernel worker.
  Imports are a minimal env built over `kfs` directly (same thread, zero
  RPC — host.js's fs env plumbing over the MountFS; read-only use). All
  calls synchronous — `labelFor()` runs inside the frame render.
- **ABI** (proposal — design freedom within the settled direction):
  exports `ksvc_init()`, then per capability; for text:
  `ksvc_text_measure(utf8, len, px) -> width` and
  `ksvc_text_render(utf8, len, px, maxW, rgba_fg) -> {ptr,w,h}` returning a
  tight RGBA bitmap in blob memory (straight alpha); kernel JS wraps it in
  `os/ksvc.js` and compositor.js uploads via `device.queue.writeTexture`
  (raw bytes — the staging canvas disappears entirely). Keep the existing
  JS-side label-texture cache; the blob keeps its own face/glyph caches.
- **Fonts — the hard part, addressed head-on**: same faces and fallback as
  gdi32/term. Face 0 = `/etc/fonts/mono.ttf` > `/usr/share/fonts/mono.ttf`
  (NotoSansMono), fallbacks via `fontchain.h` `fc_load()`
  (`/etc/fonts/fallback` — font packages append here), lazy face open,
  first-face-with-the-codepoint wins, tofu box on total miss — the exact
  `font_glyph`/`cp_glyph` discipline, so titles get the SAME CJK coverage
  as every other OS surface. Titles can contain CJK: verify the deployed
  package set includes `font-noto-cjk-mono` (+ `font-unifont`) so real
  installs render CJK titles — coverage parity with today's browser
  rendering comes from the chain plus shipped fonts, not from the host.
  Config is read at `ksvc_init` (font-package installs reach the chrome at
  next boot — the per-process-read discipline at kernel grain; a re-init
  hook is a cheap follow-up if that grates).
- **Behavior upgrades while we're here**: proper ellipsis (`…`) truncation
  at maxW instead of fillText's squish; title weight via
  `FT_GlyphSlot_Embolden` (browser used bold) — tune visually at 20px
  against the v133 chrome rhythm.
- **Headless — IN SCOPE (user ruling 2026-07-22)**: the blob is plain
  wasm, so Node's kernel (boot.js/tests) loads it too, and
  `wmScreenshotScreen` (kernel.js:5719) draws title text for real —
  ending the "text is a browser-compositor affordance" split: browser and
  headless composites agree, and title text becomes assertable in
  goldens/`wmctl shot`. Our rasterizer = same bytes everywhere, so the
  composite stays deterministic. Rebake the affected goldens — and per
  the v133 lesson, VISUALLY verify each before rebaking (goldens can
  encode bugs); text stays out of NOTHING else (chrome fills/geometry
  unchanged). The cursor stays out of the headless composite (and out of
  the browser one — see the 0276 DROPPED ruling: the CSS cursor stands).
  Sequence within the item: land the browser swap and the headless text
  in one change so the two composites never diverge on text again.
- **Failure mode**: no zombie fallbacks — if the blob fails to
  load/instantiate at boot, that's a loud boot-error, not a quiet
  fillText revival. The Canvas2D path is DELETED.

## Acceptance

- `os/compositor.js` contains no `getContext('2d')`/`measureText`/
  `fillText`; titles, the close `'x'`, and Exposé captions render via the
  ksvc blob and are visually equivalent at 20px (manual look-confirm, the
  Phase C/D precedent).
- A CJK title (e.g. `term` running with a CJK window title, or winbox with
  a set title) renders real glyphs with `font-noto-cjk-mono` installed and
  honest tofu without — matching gdi32/term coverage on the same image.
- Overlong titles ellipsize instead of squishing.
- `wmScreenshotScreen` renders title text via the same blob — headless
  and browser composites agree; affected goldens rebaked (each visually
  verified before rebake, the v133 rule) and bit-exact ACROSS
  environments thereafter.
- Kernel suite + browser sweep green.
- The service seam is documented (KERNEL.md or a ksvc README): how kernel
  JS loads/calls the blob, and that new kernel-C capabilities land as new
  exports on this blob.
