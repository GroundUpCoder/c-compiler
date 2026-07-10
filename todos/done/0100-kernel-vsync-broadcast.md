# 0100 — kernel vsync broadcast

- **Status**: done (2026-07-11) — both tiers landed: the deadline pacer
  (a1cf7d2) and the kernel vsync broadcast (KP_VSYNC_EN/SEQ tail words,
  vsyncTick from the compositor rAF, vsyncWait as the surface backend's
  requestAnimationFrame); kernel suite 45/45, browser sweep 16/16
- **Design**: todos/KERNEL.md (kernel-page layout), todos/WM.md (compositor)

## Goal

SDL frame pacing in OS processes is wall-clock, not vsync. Process workers
are nested workers (kernel-worker spawns them), and Chromium's
`requestAnimationFrame` throws `NotSupportedError` in nested workers — so
every in-OS SDL app ticks off a `setTimeout` pacer in host.js's frame-loop
driver. Meanwhile the kernel worker (first-level) has a working rAF and
already drives the compositor with it. The system owns exactly one real
vsync clock; export it to processes.

Two-part fix, one item:

1. **Deadline pacer** (precursor, host.js only): the old fallback armed a
   fixed `setTimeout(16)` *after* each frame callback, making the tick
   period 16ms + frame work. An app whose callback costs ~10ms ticked at
   ~26ms while its own catch-up logic kept game-time real — i.e. it
   silently presented every other frame. Measured on sameboy GBC in-OS:
   60 frames/s emulated, 33 presented. Aim at an absolute 60Hz schedule
   instead. This tier stays load-bearing forever: it is the only possible
   pacer where no vsync exists (standalone pages, Node/boot.js).

2. **Vsync broadcast**: a vsync counter word on the per-process kernel
   page; the kernel-worker compositor rAF bumps it for every live pcb +
   `Atomics.notify`. host.js's OS surface backend, when the kernel page
   advertises a vsync source, paces the frame loop by awaiting that word
   (`Atomics.waitAsync`) instead of the deadline timer. Zero app change —
   apps keep their own frame gates, same as under native rAF.

## Plan

- kernel.js: kernel-page layout word `KP_VSYNC` + an advertise flag set at
  spawn when the embedder declares a vsync source (`Kernel({vsyncSource})`
  or equivalent); `kernel.vsyncTick()` bumps + notifies every live pcb.
  Keep the layout comment and KERNEL.md in sync (house rule).
- os/kernel-worker.js: call `vsyncTick()` from the compositor rAF loop.
- host.js: surface backend exposes a `requestAnimationFrame` built on
  `Atomics.waitAsync(kp, KP_VSYNC, lastSeen)` when advertised (slots into
  the existing driver seam); otherwise stays null → deadline pacer.
- Lifecycle decision (made): **stop when rAF stops.** Tab hidden → no
  ticks → processes park in the wait — honest pause, zero pause code.
  Note the consequences in KERNEL.md: cooperative signals are deferred
  until the next tick (SIGKILL unaffected); AudioContext isn't throttled
  when hidden, so backgrounded games go silent instead of playing on.
  A ctlpanel toggle to switch the tick source to a `setInterval`
  heartbeat (keep-running-when-hidden) is follow-up work, its own item.

## Acceptance

- Deterministic kernel test (fake workers): vsyncTick bumps the word and
  wakes a parked waiter; the flag is advertised only when the embedder
  declares a source; no-vsync kernels leave the flag clear.
- Headless suites unchanged and green (Node never advertises vsync — the
  deadline pacer tier keeps covering boot.js/kernel e2e by construction).
- Browser: sameboy GBC presents ~60fps (was 33 pre-pacer, ~55-60 with the
  deadline pacer's beat jitter); os-sweep stays green.
