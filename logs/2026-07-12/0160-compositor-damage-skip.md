# 0160 — compositor scene-signature damage skip (idle GPU on static screens)

**Item:** todos/0160. **Landed:** 2026-07-12. Image **v85**.

## Problem

The kernel-worker compositor (`os/compositor.js`) ran a full WebGPU render
pass **every rAF** (~60fps) even when nothing on screen changed. `draw()`
opens with `kernel.vsyncTick()` (todos/0100 — that rAF IS the system frame
clock every SDL app parks on), then unconditionally sampled `wmScene()` and
submitted. Only the per-surface texture *upload* was gated (on `SH_SEQ`); the
*submit* was not. A settled desktop or a static slide burned a fixed ~60fps of
GPU compositing for zero visible change.

## What landed

**Compositor damage skip (`os/compositor.js`).** After the unconditional
`vsyncTick()`, `draw()` builds a cheap per-frame **scene signature** and, when
it equals the previous submitted frame's, `requestAnimationFrame`s and returns
WITHOUT touching the swap chain — no `getCurrentTexture()`, no submit, so the
GPU idles and the canvas keeps presenting the last frame. The clock keeps
ticking (the hidden-tab "everything parks" property is unchanged: no rAF → no
tick → no frame).

The signature folds in only what `scene.version` (`_wmVersion` in kernel.js)
does NOT already cover. `_wmVersion` bumps on *every* geometry/z/focus/map/
create/destroy/resize/DST/layer/glass/title/resizeDrag change (verified against
all bump sites), so the signature is just:

```
[ version, frameW, frameH, anims.length,  (sid, contentId)* ]
```

where `contentId` is the gpu surface's `ImageBitmap` identity (=== by ref) or
the shm surface's `SH_SEQ` — an app's *present* bumps neither the WM version
nor any geometry, so content is the one thing version misses. Compositor-driven
minimize/restore fly animations repaint on the wall clock with no version/
content change, so **any active anim forces a submit every frame**, and the
`anims.length` term makes the settle frame (when the last anim expires) differ
from the final flying frame. Belt-and-suspenders: when unsure, submit — a stale
frame is the classic damage-tracking bug, a redundant submit is merely wasted.

**Taskbar present gate (`os/wm.c`).** The plan scoped 0160 as "pure
compositor.js change," but that was insufficient: `draw_bar()` redrew and
called `SDL_UpdateWindowSurface(bar_win)` **every** `frame_cb`, and `shmPresent`
(host.js) bumps `WMSH_SEQ` *unconditionally* per present. So the taskbar's
`SH_SEQ` churned every frame → the signature differed every frame → the skip
would never engage on any real desktop. The compositor half is correct but
dead-on-arrival without stopping the churn at the source. Fix: `bar_present()`
memcmp's the freshly-drawn bar bytes against the last-presented snapshot and
presents only on change (catches the clock's per-minute tick, focus relief,
overflow shrink, Show-Desktop press state — everything `draw_bar` renders). The
desktop layer was already `desk_dirty`-gated, `term` is `dirty`-gated, and mgp
presents only on paging, so the taskbar was the lone always-on churner.

This is the scope correction the item's "restructuring is valid" clause allows:
the compositor skip is 0160's core; the taskbar gate is the necessary companion
that makes it observable. No new todo was needed — the broader "idle poll-loop
apps keep waking every rAF / keep presenting identical frames" concern is
**0161** (already queued directly after 0160, `SDL_WaitEvent`/idle-park).

**Test probe.** `self.__compositorStats = {frames, submits, skipped}` in the
compositor; `kernel-worker.js` answers a `{type:'compositor-stats'}` message
with a snapshot; `os.html` exposes `window.__osCompositorStats()` (a request/
response promise) + `window.__osCompositor`.

## Boundary (by design, not a bug)

An app that *presents identical frames every rAF* (the `winbox` acceptance app
redraws + presents unconditionally in its `frame_cb`) keeps the GPU submitting —
the compositor sees a fresh `SH_SEQ` each frame and correctly treats it as
damage (content-hashing every surface to detect "presented but identical" would
tax genuinely-animating apps like doom on every frame, so it was rejected).
Parking such idle poll-loop apps off the vsync wake list is exactly **0161**.
Well-behaved apps (dirty-gated term, paging-gated mgp, and now the taskbar) let
the screen go fully idle.

## Tests

New `tests/browser/os-compositor.mjs` (auto-discovered by `os-sweep.mjs`),
driving the LIVE compositor: static desktop idles (submits stop while frames +
skips keep counting — clock never stops); an idle screen still repaints the
instant something changes (Start menu open → submit); it re-idles after the
change; a continuously-presenting app (winbox) keeps the GPU submitting (the
gate never drops a real frame); and the screen idles again once that app exits.
**PASS** (11/11).

Regression: kernel suite (compiles/runs the new wm.c) + the WM/shell/vt browser
legs + the `tests/flake.js` frame-loop gate.
