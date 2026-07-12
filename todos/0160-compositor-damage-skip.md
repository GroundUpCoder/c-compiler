# 0160 — compositor: scene-signature damage skip (idle GPU on static screens)

- **Status**: deferred (2026-07-12; an implementation was landed then reverted —
  see the Deferral note; was: open). **Superseded framing:** see
  `todos/IDLE-POWER.md` — this item's "keep the 60 Hz heartbeat, skip the submit"
  goal is now understood as a half-measure; the idle-zero design folds it into
  piece A (on-demand compositor) + piece D (taskbar gate). Read IDLE-POWER first.
- **Design**: this file + `todos/IDLE-POWER.md` (found profiling the 0119 mgp
  present path)

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

## Deferral note (2026-07-12)

A full implementation was written, verified in the browser, then **reverted**
per direction — preserved in history at commit `659902d` (revert `2d8433a`).
Deferred alongside 0161 pending rework. What the attempt established, so the
next pass doesn't rediscover it:

- **The compositor half works and is cheap.** After the unconditional
  `vsyncTick()`, `draw()` builds a per-frame signature `[version, frameW,
  frameH, anims.length, (sid, contentId)*]` where `contentId` is the shm
  surface's `SH_SEQ` or the gpu surface's `ImageBitmap` identity, and skips the
  submit (no `getCurrentTexture()`, GPU idles) when it matches the last frame.
  `_wmVersion` (kernel.js) already covers all geometry/z/focus/map/glass/title/
  resizeDrag changes; content is the only thing it misses. An active anim forces
  a submit every frame. A browser test (`tests/browser/os-compositor.mjs`, 11/11)
  confirmed the desktop idles, the clock keeps ticking, and every real change
  repaints.
- **"Pure compositor.js" is NOT sufficient — and that's the crux to resolve.**
  `wm.c`'s `draw_bar()` presents the taskbar EVERY frame, and host.js
  `shmPresent` bumps `SH_SEQ` unconditionally, so the taskbar churns the
  signature every frame and the skip never engages on a real desktop. The
  attempt added a `bar_present()` content-memcmp gate in wm.c (present only on
  change) as the companion. That works, but it means the item can't be
  compositor-only; decide the right shape: (a) the wm.c taskbar gate (localized,
  taxes nobody, but an app change), (b) a general host.js "don't present a frame
  identical to the front buffer" skip in `shmPresent` (benefits all apps but
  changes present semantics for every process/test), or (c) fold it into 0161
  (park idle poll-loop apps so they stop presenting at all).
- **Triage RESOLVED (2026-07-12 review, not flake, not a 0160 regression):**
  both failure sets were the `785eca2` (notepad desktop icon) hardcode class.
  `test_recycle_e2e` (6) was fixed by todos/0164 (commit `33d836b`, derive the
  bin's grid row from live state). `test_wm_service_e2e` (3: dblclick-on-term,
  `.icons` layout, Ctrl+A) **still fails on clean main**: `DESK_ENTRIES`
  (tests/kernel/test_wm_service_e2e.js:79-80) lists 7 launchers and omits
  `notepad`. Fix the same way as 0164 (P0, land before any re-land here or the
  same 3 failures re-muddy the verdict).
- Boundary that stands regardless: an app presenting identical frames every rAF
  (the `winbox` acceptance app) correctly keeps the GPU busy under 0160 alone —
  that's 0161's domain.
