# NetSurf interaction truth — the bug-hunt lane

Lane: `netsurf-bughunt` (Fable, Playwright-driven). Origin: jku opened the
paint demo on the deployed site and reported that no visual worked.

## Why this lane exists

The demos e2e asserted a load-check pill and called that "the page works".
The pill proves the subresources loaded. It does not prove that a click, a
drag or a timer changes one pixel. jku's report pointed at exactly that gap.
This lane built the missing layer: drive each demo's REAL interaction and
hold the pixels to declared expectations.

## The verdict on the report

The deployed pair is healthy. The edge serves image 192 and commit
`8e34f2f0`, and the packages repo matches. A fresh Chromium profile against
`groundupcoder.com` boots, installs `netsurf-demos`, and paints a real
multi-point stroke — with the mouse and with a touch drag. A local bake at
the same commit behaves the same, pixel for pixel. The report does not
reproduce here. The two variants this rig cannot drive: Safari (Playwright's
WebKit has no worker WebGPU, so gucOS refuses to boot in it), and a stale
client cache in jku's own profile. Ask jku for a hard reload, or for his
browser and the exact gesture.

## What was built

- `vendor/netsurf/demos/demos.js` gained `INTERACTIONS`: one table that
  declares, per demo, the driven phases (clicks, held-pointer strokes, typed
  keys, timer settles) and the pixel expectations per phase (changed /
  byte-identical / ink / colour, by page-pixel region). The contract check
  now REFUSES a demo without one.
- The kernel e2e (`test_netsurf_demos_e2e.js`) drives that table through
  `wmctl` client-coordinate injection, with a dead-page control: the same
  clicks on the script-stripped copy must change nothing. A failed
  expectation persists the phase shots as PNGs.
- `tests/lib/png.js`: a dependency-free PNG encoder and P6 parser — the
  screenshot persist step the estate lacked.
- `tests/browser/nsdemos-interact.mjs`: the same table driven with real
  Chromium input against a booted OS (local or deployed), one PNG per phase.
- `tests/kernel/nsprobe-subset.js`: custom in-OS probe pages for subset
  claims the demos do not exercise.

## Findings

- All 7 demos pass all 29 interaction expectations, locally and against the
  deployed edge. The engine claims Lane A/B/C makes are TRUE on pixels:
  click dispatch and phases, coordinates, keydown/keyup/input/change/focus,
  cancelable submit, textContent/appendChild/removeChild/className repaint,
  ImageData canvas, timers.
- Probes proved: link navigation, wheel scroll, small `<img>` at load,
  `setTimeout`/`clearTimeout`, `setAttribute('style')` restyle, and Enter
  arriving as `event.key === 'Enter'` (the todo demo's comment claimed the
  opposite — stale, fixed).
- **todos/0419 (P0)**: `preventDefault()` in a link's click listener cannot
  stop the navigation. The click fires before the deferred navigate, but the
  dispatch result is ignored. The listener's effects are also lost with the
  replaced document.
- **todos/0420**: `:hover` never matches — upstream `node_is_hover` is a
  `\todo` stub. The pointer tracking itself works (status bar names the
  link target).
- **todos/0421**: page `console.log` reaches no tty in the OS — the gucos
  window table has no `console_log` entry. The demos document the console
  as their evidence channel; in the OS it is a black hole.
- The events demo hid its own late events: the keys readout clips at its
  width, so `change:check` and `submit` changed no pixels. The readout now
  shows the trail tail (package payload `2`).

## Traps recorded for the next lane

- The tty echoes TYPED lines into `__osOut`, so an unsplit marker satisfies
  its own wait. Split every needle.
- `page.screenshot` cannot see the desktop: the canvas is transferred to
  the worker. Draw it into a temp canvas and read that.
- The first window sits at (12,36) with an 800x600 surface; page pixel ==
  surface pixel while the page is unscrolled — that identity is what makes
  ONE coordinate table serve both drivers.
