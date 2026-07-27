# 0167 — wire 0100's vsyncWait pacing into the browser SDL flavor (IDLE-POWER Stage 1)

- **Status**: done
- **Design**: `todos/IDLE-POWER.md` (Stage 1) + `todos/KERNEL.md` "The vsync
  broadcast" (whose description this item makes true).

## Goal

Verified 2026-07-12: the `hooks.vsyncWait().then(cb)` requestAnimationFrame
shim (host.js ~6156) lives only in the headless/shm flavor's return object;
the browser flavor returns earlier (~6135, `out = Object.assign({}, inner)`)
inheriting `createBrowserSDL`'s deadline-setTimeout latch — and headless
kernels never advertise vsync, so the shim is dead code everywhere. No
process parks on `KP_VSYNC_SEQ`, `vsyncTick()` notifies nobody, and the
documented "tab hidden = SDL apps park" is intent, not behavior (hidden
tabs throttle timers; apps slow, they don't park).

Goal: slot the vsync shim into the browser flavor's returned backend
(`out.requestAnimationFrame`, gated on `hooks.vsyncEnabled()` exactly like
the headless site), so browser SDL frame loops pace on the compositor rAF —
the prerequisite for every later IDLE-POWER stage (piece B's doorbell site
must be live code).

## Plan

- host.js browser flavor (~6129): set `out.requestAnimationFrame` to the
  vsyncWait shim when the kernel advertises vsync; keep the inherited
  deadline pacer otherwise (standalone browser pages stay untouched).
- Remove the stale-intent caveats this makes obsolete: CLAUDE.md os/ section
  and KERNEL.md "vsync broadcast" GAP note (added 2026-07-12).
- Frame pacing semantics to watch: vsyncWait's rAF catch-up collapses missed
  ticks — sameboy/doom present cadence must not regress (the 0100 fps-halving
  class); verify presented-fps parity in the browser sweep.

## Acceptance

- Browser os-sweep green (`node tests/browser/os-sweep.mjs`), in particular
  os-doom/os-gpubox/os-term visual + audio legs (pacing changed for every
  browser SDL app — this is the real gate).
- Hidden-tab park is now real: with the desktop tab hidden, app workers stop
  waking (probe-able via the 0169 wake counters later; for now assert no
  presented-frame progress while hidden, resumes on show).
  **AMENDED 2026-07-13: the "for now" assert is impossible in this
  harness** — measured with worker-rAF probes against BOTH Playwright
  flavors (headless shell and `channel: 'chromium'` new headless): a
  backgrounded tab (`page.bringToFront()` on a sibling) stays
  `document.visibilityState === 'visible'` and worker rAF keeps ticking
  ~67/s (Playwright launches Chromium with background throttling/occlusion
  disabled by design). Park is structural — `vsyncWait` is a no-timeout
  futex wait, so no rAF tick = no wake, there is no fallback path — and
  the automated observable lands with 0169's wake counters. A headed-
  browser manual check (hide the real tab, doom freezes; reshow, resumes)
  joins the per-round human checks (WM.md "Known issues" precedent).
- `node tests/flake.js` — frame-loop change, the gate is mandatory.
- Kernel suite unaffected (headless path untouched by construction).
