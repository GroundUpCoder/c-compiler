# 0160 — compositor: scene-signature damage skip (idle GPU on static screens)

- **Status**: open
- **Design**: this file (found profiling the 0119 mgp present path)

## Goal

The kernel-worker compositor (`os/compositor.js`) runs a full WebGPU render
pass **every rAF** (~60fps) even when nothing on screen changed. Its `draw()`
opens with `kernel.vsyncTick()` (todos/0100 — that rAF IS the system frame
clock every SDL app parks on), then unconditionally samples `wmScene()` and
submits. Only the per-surface texture **upload** is gated (on `SH_SEQ`); the
**submit** is not. So a static desktop — a settled mgp slide, an idle
terminal — burns a fixed ~60fps of GPU compositing for zero visible change.

That waste is a compositor-architecture property: vsync is the sole pacing
primitive and it's fused 1:1 to the render submit with no damage gate.

Goal: **keep ticking the clock every rAF (pacing unchanged), but skip the GPU
render-pass submit when the scene is provably identical to the last frame.**
Standard compositor damage tracking. GPU idles on a static screen; the honest
"hidden tab parks everything" property is preserved (no ticks → no frames).

## Plan

- After `vsyncTick()` (which must stay unconditional — apps rely on it), build
  a cheap **scene signature** before the pass:
  - the z-ordered visible-surface list, and per surface
    `{sid, x, y, w, h, dstW, dstH, layer, mapped, SH_SEQ}` (the kernel already
    reads `SH_SEQ` for the seq-gated upload — nearly free);
  - cursor position + shape, focus/menu/popup furniture state;
  - **any compositor-driven animation active** — minimize/restore fly, glass
    blur, Aero Peek/thumbnail, snap preview, screensaver (these repaint with no
    app present, so the signature must force a submit while they run; the
    compositor already owns its anim clock at the top of `draw()`).
- If the signature equals the previous frame's → `requestAnimationFrame(draw)`
  and return WITHOUT submitting. Else submit and store the new signature.
- Belt-and-suspenders against the classic damage-tracking staleness bug (a
  missed damage → stale frame): always submit on the first frame after any
  geometry/z/map/create/destroy/resize/DST/layer op and after a swap-chain
  reconfigure (screen resize). When unsure, submit.
- Keep it a pure `compositor.js` change — no protocol, no app, no kernel-page
  layout change. Measure idle GPU time before/after (a static VT2 desktop).

## Acceptance

- A static screen (settled mgp slide; idle desktop) issues **no** GPU submits
  after the scene settles, verified by a submit counter exposed for the test.
- Every real change still repaints within one frame: window move/resize/close,
  focus, menu open, cursor move, an app presenting a new frame, and every
  compositor animation (minimize fly, glass, snap preview, screensaver).
- Browser os-sweep visual legs unchanged (no dropped/stale frames); run the
  flake gate (`tests/flake.js`) since this touches the frame loop.
- Pairs with 0161 (idle apps off the vsync wake list) for a fully idle system;
  0160 is the safe, self-contained first step (GPU only, no SDL-contract change).
