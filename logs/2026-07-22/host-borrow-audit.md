# Host-borrowed-shortcut audit (queued: 0275, 0276)

The trigger: while describing the graphics stack we noticed window-title
text is rasterized by the BROWSER (compositor.js `labelFor` — Canvas2D
`fillText`, `'bold 20px sans-serif'`), not our FreeType/Noto stack. That
was never the intent, and the 2026-07-09 framing of it as "a texture
SOURCE, not scene assembly" is rejected as a carve-out. This log records a
full sweep of the OS surface for shortcuts of that kind. The bar applied:
**pixels and behavior the OS presents should be produced by our stack; the
browser is the hardware, not a co-renderer.** Platform seams that ARE the
hardware (WebGPU device/present, SABs, raw input events, OPFS, the
AudioContext output device, rAF-as-vsync per 0100) are not findings.

## Findings → queued

1. **Compositor label text** — `os/compositor.js:342-379` (`labelFor`);
   call sites :437 (Exposé captions), :685 (close `'x'`), :687 (titles).
   Canvas2D `measureText`/`fillText` (maxWidth SQUISH), browser `sans-serif`
   metrics decide OS chrome text. Also the reason the headless composite
   deliberately has no text (`kernel.js:5719` — "text is a
   browser-compositor affordance"), i.e. browser and headless screenshots
   disagree by construction. → **0275** (direction settled by the user: a
   growable kernel-side C wasm service blob, FreeType + fontchain.h, built
   by our own compiler, called synchronously from `labelFor`; ellipsis
   replaces the squish).
2. **Mouse cursor** — `os/os.html:518-535`: the kernel computes the
   effective shape (0105) but the sprite is the host's CSS cursor
   (`canvas.style.cursor`, `CURSOR_CSS_MAP`). Per-platform art, absent
   from every capture. Standing WM.md deviation (~1085), now promoted.
   → **0276** (compositor-drawn sprite, art from our stack — lean: a
   second ksvc capability).

## Findings classified NOT-borrowed / exempt (verified, for the record)

- **Taskbar clock / datepop**: formatted in `os/wm.c` (~4043,
  `time()`/`localtime()`); the host only supplies the clock. Clean.
- **Image decoding**: no `new Image`/`ImageDecoder`/`createImageBitmap`
  on encoded bytes anywhere on the OS path — present-path ImageBitmaps
  carry raw pixels (transport). Icon/desktop art is wm.c-drawn; in-OS
  PNG work is libpng. Clean.
- **`host.js:10849-10898` `fb_refresh`** (Canvas2D `putImageData`): the
  tinyemu framebuffer present on the STANDALONE runtime. Raw-pixel
  transport, and tinyemu is not seeded/packaged — zero references in
  `os/`. Not on the gucOS path; left alone.
- **Clipboard**: the OS clipboard is the kernel slot (0090);
  `navigator.clipboard` only bridges to the HOST clipboard (#79, a
  deliberate integration, not borrowed rendering).
- **Audio**: kernel mixes (0017); the page's AudioContext is the output
  device. Clean.
- **CSS animations**: none stand in for OS animation — minimize/restore
  fly and Exposé transitions are compositor-drawn. Clean.
- **Boot guard screens / status strip / VT tab bar / font-zoom
  controls**: page furniture AROUND the screen canvas — the "monitor
  bezel", harness chrome (and the tab bar is deliberate discoverable UI,
  0022/0070). Pre-boot screens are pre-OS. Exempt.

## Borderline — flagged to the user, not queued (provisional)

- **VT1 xterm.js**: the entire terminal pane (glyphs, cursor blink, VT
  parsing, native DOM paste) is a browser-side JS widget. Documented as
  the deliberate "dumb UI bridge" (os.html header; WM.md notes the
  positioned-xterm design as still queued), and arguably the host-side
  serial console — the OS's OWN terminal is `/bin/term` (FreeType). Open
  question whether self-hosting the console is wanted.
- **Mobile OSK + VT1 keystrip** (`os/osk.js`, os.html): DOM/CSS keyboards
  with browser-rendered legends and browser-timer key repeat. Reading:
  input PERIPHERAL (a keyboard the host renders), recently built
  deliberately page-side; must also serve VT1 where no compositor exists.
- **Touch long-press → context menu + `navigator.vibrate` (os.html
  ~627)**: gesture POLICY and haptics live in the page, not the
  kernel/wm. Small; part of the active mobile campaign's deliberate
  page-side shape.

Verdicts on the borderlines are the user's; the queue items stand on
their own either way.
