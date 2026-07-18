# VT2 desktop zoom (crisp integer downscale) + VT1 terminal default bump

Branch `vt2-zoom` (worktree off origin/main). Page-only change — `os/os.html`
plus browser tests. NOT a bake input (os.html is the host page comguc serves,
absent from `os/image.json` / `tools/mkimage.js`), so no mkimage bake and no
collision with #81's v126 image work. Needs a page deploy eventually; deploy is
held/serialized behind #81 by the coordinator — this branch stops at
implemented/gated/logged/committed.

## Deliverable 1 — VT2 desktop zoom

An integer zoom factor Z ∈ {1,2,3} magnifies the whole desktop. The design goal
was crispness with zero taint of the render/wm coordinate path — the page
comment at the old syncScreenSize deliberately rejected a *render-path* scale
factor as "tainting every coordinate path" (todos/0023), and that ruling holds.

### Why integer-only (the whole point)
Integer scale + `image-rendering: pixelated` (nearest-neighbor) = exact NxN
blocks, **zero blur**, and an integer-clean pointer map (`c/Z`). A fractional Z
would reintroduce two problems at once: bilinear blur on the upscale, and
non-integer pointer drift on the coord divide. So the ramp is 1/2/3, no
fractional steps — documented in the code.

### The decoupled approach — bigger by rendering FEWER pixels
Rather than scaling the render, we shrink what's rendered and let the browser
upscale it:

1. **Backing store shrinks.** `syncScreenSize()` reports `floor(pane/Z) ×
   floor(pane/Z)` to the worker (was `pane × pane`). The worker already resizes
   the OffscreenCanvas from that message + re-calls `wmSetScreen` → EV_SCREEN +
   kernel clamp, so the wm just sees a smaller screen — another ordinary resize.
   **wm.c is untouched** (verified: it already handles arbitrary screen sizes).
2. **Display pinned to the full pane.** A transferred canvas has NO CSS size, so
   it would otherwise *display* at its (now smaller) backing size — the opposite
   of bigger. The page sets `screen.style.width/height = pane` (CSS display size,
   independent of the worker-owned backing store), so `floor(pane/Z)` pixels
   upscale to fill the pane ⇒ everything Z× bigger.
3. **Crispness.** `#screen { image-rendering: pixelated }` makes the integer
   upscale sharp blocks.

### The ONE coordinate seam — divide incoming pointer coords by Z
The canvas is displayed Z× larger than its backing, so page pointer coords (CSS
px) map back to logical/backing px by dividing by Z. Confined to:
- `mapX`/`mapY` helpers (round `c/Z`) used at mousedown/up, mousemove(absolute),
  wheel position (deltaX/Y are scroll amounts — untouched).
- Locked (pointer-lock) relative deltas: `movementX/Z`, `movementY/Z`.
- Touch: the single `touchXY()` divides — so taps, drags, and the two-finger
  scroll midpoints (computed from its outputs) are all logical, one seam.

This confined divide IS the "taint" the 0023 comment warned about; it stays on
the page pointer path and is never threaded into the wm/render.

### Control + persistence
- `#zoomctl` A −/label/+ stepper in the tab bar, mirroring VT1's A−/A+; shown
  only on VT2 + touch UI (`body[data-vt="2"][data-touchui]`), so a non-touch
  desktop defaults Z=1 and hides it.
- Persists in `localStorage['gucos.vt2.zoom']` (1..3); probe `window.__osVt2Zoom`
  (+ `window.__osVt2SetZoom` for tests). `window.__osScreen`/`screenSent` stay
  LOGICAL (divided) dims so the dedupe + re-sync stay correct — a Z change keeps
  the pane px but changes `floor(pane/Z)`, so the dedupe passes and a real
  screen-resize is resent.

## Deliverable 2 — VT1 terminal default bump
`VT1_FONTS` grew `[12,14,18,22,26]` → `[12,14,18,22,26,30,34]` (appending keeps
existing indices stable, so a previously-stored 18/22/26 still resolves). The
phone/touch default (`min(innerW,innerH) <= 700`) went 18 → **26** (14→18→22→26,
~3 steps above the desktop 14, which stays 14). localStorage override + probe
unchanged.

## Gate (page-side → gucOS browser sweep, layer-matched)
- New `tests/browser/os-vt2zoom.mjs` (17 checks, PASS): control+persist, backing
  = floor(pane/2) with display pinned to pane, pixelated, ~2× display; the
  coordinate seam proven end-to-end — a physical click at CSS `(Start*Z)` opens
  the Start menu at the right logical coord (without the divide it would land
  below the logical screen and miss); a title drag by CSS `(+200,+100)` moves the
  window by the logical `(+100,+50)`; taskbar renders under zoom; persists across
  reload. Auto-discovered by `os-sweep.mjs`.
- `os-vt1mobile.mjs` updated: narrow-viewport default 18 → 26.
- Regression: `os-screen` / `os-scale` / `os-touch` (Z=1 unchanged, `c/1`
  identity) PASS; `os-shell` / `os-vt` / `os-wm` PASS (CSS #screen + new vtbar
  element don't disturb the desktop pixel/VT paths).
- No bake needed (os.html not a bake input); compiler.js / kernel.js / wm.c /
  host.js UNTOUCHED.

Screenshots (same 820×990 display, Z=1 vs Z=2 crisp upscale — visibly bigger
UI, sharp nearest-neighbor blocks): `logs/2026-07-18/vt2-zoom-1x.png`,
`vt2-zoom-2x.png`.
