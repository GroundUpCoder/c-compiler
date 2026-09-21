# 0169 — on-demand compositor: dirty-gated submit, parked rAF, damage doorbells (IDLE-POWER Stage 4)

- **Status**: done (2026-07-14) — landed as four commits: c0481d1 (kernel ARMED/PARKED wake protocol + KP_VSYNC_ARMED/KP_COMP_PARKED tail words), 2eeaf21 (host doorbell-on-present + frame-idle), 06a6cba (compositor dirty-gated submit + parked rAF), 0625cc0 (os-compositor.mjs + flake tripwire); close-out gate caught and fixed the socket→ring lost-notify race (e23d1f7 — the kick pushes a type-0 ring record now) and registered comp_park in the suite table (22d7c12). Idle desktop: 350% → 8.8% total CPU (gpu 340.6% → 0.2%); story in logs/2026-07-14/idle-power-stage4.md
- **Design**: `todos/IDLE-POWER.md` (pieces A + B + E — read it first; the
  wake-coverage table and the ARMED/PARKED Dekker protocol there are
  normative). Absorbs the damage-skip half of todos/0160 (signature/skip
  mechanism + `tests/browser/os-compositor.mjs` recoverable from `659902d`;
  close 0160 when this lands).

## Goal

The compositor composites + submits every rAF forever. Make it event-driven:
dirty = (any surface seq/bitmap changed) OR (`_wmVersion` changed) OR (a fly
anim is active); re-arm rAF iff keepAlive (any wantFrame, any registered
vsync waiter, anim active) or within a short armed-frames GRACE; else park.
`scheduleFrame()` re-arms from the wake hooks. Result: a settled screen has
zero GPU submits and zero app-worker wakeups.

## Plan

Per IDLE-POWER piece B, summarizing (the doc is normative):

- Two per-pcb kernel-page tail words `KP_VSYNC_ARMED`/`KP_COMP_PARKED`
  (payload cap −8; KERNEL.md layout comment + tests in sync).
- Shim: ARMED++ before waitAsync, ring `want-frame` if PARKED; `shmPresent`
  (+ Dawn twin) rings if PARKED after the seq bump (doorbell-on-PRESENT —
  covers the pumpWait/WM_TIMER presenters); `_wmFrame` calls
  `scheduleFrame()` unconditionally.
- Park = Dekker: store PARKED on every pcb page, then re-read every
  ARMED/wantFrame/seq; any hit → unpark. wantFrame is hard state (set on
  doorbell; cleared only on WaitEvent entry + reap; stamped at
  spawn-while-parked).
- Route the 20 `_wmVersion++` sites through `_bumpWmVersion()` →
  scheduleFrame; wire `wm-input`/`screen-resize`/`wm-canvas`/`drop-file`/
  `wm-frame` handlers. Park decisions read the post-prune anim scene of an
  already-drawn frame. Do NOT add a vsyncWait timeout (breaks the
  hidden-tab honest pause).
- ~~audioPump interval gated on live-stream count~~ — pulled forward,
  landed as a standalone pre-Stage-3 commit (2026-07-14).
- Tests: resurrect os-compositor.mjs from `659902d`, extend with submit AND
  app-worker-wake counters (probe surface in kernel.js/host.js); add to
  tests/flake.js; measure idle CPU%/GPU/wakeups after (static desktop;
  3–4 windows) against the committed pre-Stage-3 baseline dev log — the
  thermal claim must be shown.
- **Hidden-tab assertion strategy (decided up front, 2026-07-14):**
  Playwright can't hide a tab for real (background throttling/occlusion
  disabled in both headless flavors — a backgrounded tab stays
  `visibilityState==='visible'`, worker rAF ~67/s). Assert park via the
  wake/submit counters plus a synthetic vsync-stop (test flag stops
  `vsyncTick()`; app-worker wake counters go flat); the true hidden-tab
  behavior stays a headed manual check (WM.md "Known issues" list).

## Acceptance

Per IDLE-POWER "Acceptance" verbatim, highlights: settled mgp slide AND
idle desktop → 0 submits + 0 app-worker wakes; every wake-table row
repaints within a frame (incl. WM_TIMER repaint while parked and the
raise-only-focus 0165 case); screensaver raises on a fully-parked desktop;
hidden-tab park preserved; browser sweep + flake gate green.
