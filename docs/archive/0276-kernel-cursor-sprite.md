# 0276 — Kernel-composited mouse cursor sprite (retire the CSS cursor deviation)

- **Status**: DROPPED (user ruling 2026-07-22 — the one-frame composited-
  cursor latency is not worth paying; the native CSS cursor is BLESSED as
  the deliberate design, not a debt item. Shape policy stays kernel-owned
  per 0105; the ruling is recorded in the WM.md deviations list and
  `logs/2026-07-22/host-borrow-audit.md`. Revisit only if requirements
  change, e.g. cursor-in-capture becomes a need.)
- **Design**: todos/WM.md deviations list (~1085) has the standing state
- **Difficulty**: medium

## Goal

The mouse pointer over the desktop is the HOST's cursor: the kernel already
derives the effective `SDL_SystemCursor` shape per pointer move (todos/0105
— per-surface `SDL_SetCursor` overlaid with chrome resize shapes from the
kernel's own hit test), but the SPRITE is rendered by the browser —
`os/os.html:518-535` maps the shape to `canvas.style.cursor` via
`CURSOR_CSS_MAP`. So the one moving pixel-object the user stares at all day
is drawn per-platform by the host (different arrow art on macOS/Windows/
Linux), never appears in screenshots/goldens, and the headless composite
has no cursor at all. Policy is already ours; only the pixels are borrowed.
Retire the deviation: the compositor draws the cursor from our own sprites.

## Plan

- **Sprites from our stack**: cursor bitmaps for the SDL_SystemCursor set
  we actually emit (arrow, text/I-beam, wait, crosshair, resize EW/NS/NWSE/
  NESW, hand, not-allowed…) rendered by OUR code — either tiny C-drawn
  monochrome+outline sprites added to the 0275 ksvc blob (its second
  capability: `ksvc_cursor_render(shape) -> {ptr,w,h,hotx,hoty}`), or
  static RGBA arrays baked into the image. Lean: ksvc export — keeps
  pixels in kernel-C and the blob growable, per the 0275 direction.
  Classic Win95-style black-with-white-outline art fits the desktop idiom.
- **Compositor**: track pointer x/y kernel-side (the kernel already sees
  every pointer event — `_wmLastInput` stamps at the wmKey/wmPointer
  entries), draw ONE topmost textured quad per frame at (x,y) minus the
  shape's hotspot, above all layers/chrome/animations. Shape −1 (hidden)
  and pointer-lock draw nothing. Pointer motion already wakes the parked
  on-demand rAF (kernel-worker.js wm-input → `scheduleFrame()`), so a
  parked-idle desktop still shows the cursor move.
- **Page**: `canvas.style.cursor` becomes a constant `'none'` over the
  desktop canvas; `CURSOR_CSS_MAP` and the `{type:'cursor'}` plumbing to
  the page die (the kernel keeps the shape state — it feeds the sprite
  pick and the `wmctl cursor` query). No zombie fallback: the CSS map is
  deleted, not kept as an option.
- **Headless**: the deterministic composite gains the cursor sprite only
  if we choose to — same goldens question as 0275's headless text; default
  leave `wmScreenshotScreen` cursor-free in this item, note the follow-up.
- **Trade-offs to accept** (called out for the record): a composited
  cursor is one frame behind the hardware cursor (rAF-paced ~16ms — the
  standard price every real compositor pays) and freezes with the scene
  when the tab is hidden (honest pause; invisible anyway). Latency on a
  120Hz display is bounded by rAF cadence.

## Acceptance

- Moving the mouse over VT2 shows OUR cursor art; DOM inspection shows
  `cursor: none` on the desktop canvas; shape changes (EDIT hover I-beam,
  resizable-frame edges, wait) swap the sprite exactly where CURSOR_CSS
  used to.
- `wmctl shot`-style browser captures (drawImage probe) now CONTAIN the
  cursor at the injected pointer position — assert pixel presence at a
  known hotspot in the browser sweep.
- Pointer lock and shape −1 hide it; unlock restores it.
- `wmctl cursor X Y` (WMP_CURSOR_AT) semantics unchanged; kernel suite +
  full browser sweep green; goldens byte-identical (headless composite
  untouched).
