# Frame pacing: the sameboy-GBC every-other-frame bug (todos/0100)

Symptom report: sameboy GBC games felt like "every other frame is being
missed" while stills looked correct, and the boot logo ("loading icon")
ran in visible slow motion; DMG games felt fine.

## Diagnosis

Not a SameBoy bug — a host.js frame-pacer bug that affects every SDL app,
with sameboy-CGB just heavy enough to expose it.

OS process workers are nested workers (kernel-worker spawns them), and
Chromium's `requestAnimationFrame` throws `NotSupportedError` there, so
in-OS SDL apps tick off host.js's `setTimeout` fallback. That fallback
armed a fixed `setTimeout(16)` *after* the frame callback returned, so
the real tick period was 16ms + frame work. main.c's catch-up loop then
kept game-time real by emulating extra frames per tick — but presenting
only the last. Feedback equilibrium: heavier frames → later ticks → more
catch-up per tick.

Instrumented main.c, real OS headless, Super Mario Bros. Deluxe:

- steady state: `ticks=33 emu=60 present=33` per second — full-speed
  emulation, literally every other frame never presented;
- boot: `ticks=10 emu=40 resync=10` — boot frames cost ~16-20ms each
  while the wasm is still in V8's baseline tier (~5-6ms once tiered up),
  so the pacer degraded to 10Hz, hit the 4-frame catch-up cap, and
  dropped emulated time → slow-motion logo at 10fps. The tier-up cost is
  real and remains; the catch-up cap correctly refuses to spiral on it.

DMG at ~5.5ms/frame equilibrated around ~42fps — "seems ok". Measured
with `GB_run_frame` throughput (bench: ~5.5ms DMG, ~6.5ms CGB in-game,
steady state, Node) — raw emulation was never the problem.

## Fix, in two tiers (both under todos/0100)

1. **Deadline pacer** (landed first): the setTimeout fallback aims at an
   absolute 60Hz schedule (`delay = nextDue - now`, cadence restarts on
   overrun) in both fallback sites — the frame-loop driver and the
   browser-SDL nested-worker rAF shim. Result: 60 emulated / ~55-60
   presented. This tier is permanent: it's the only possible pacer where
   no vsync exists (standalone pages, Node/boot.js).

2. **Kernel vsync broadcast** (the 0100 body): the kernel worker is
   first-level and already runs a real rAF for the compositor — export
   that clock: a counter word on the per-process kernel page, bumped +
   notified per compositor frame; host.js's surface backend paces the
   frame loop off `Atomics.waitAsync` on it when advertised. Kills the
   residual beat jitter (free-running 60.00Hz producer vs vsync-locked
   sampler → periodic double/missed sample) and phase-aligns presents
   just before the composite that reads them.

Decisions:

- **Stop when rAF stops.** Tab hidden → no ticks → processes park in the
  wait. Honest pause, zero pause code. Consequences documented in
  KERNEL.md (cooperative signals defer to the next tick; backgrounded
  games go silent since AudioContext isn't throttled when hidden).
- A ctlpanel toggle to switch the kernel tick source to a `setInterval`
  heartbeat (keep-running-when-hidden) is queued as its own item.
- Re-parenting process workers to the main thread (to get native rAF)
  was considered and rejected: it splits process ownership across two
  contexts (spawn/kill/EXIT gain a main-thread hop and its failure
  modes), diverges the Node topology, and buys only per-process rAF —
  less coordinated than one broadcast from the clock the compositor
  actually samples on.

## Implementation notes (the landed 0100 broadcast)

- The kernel page had no free word (0-7 allocated, payload at byte 32),
  so the two vsync words live at the page TAIL and `KP_PAYLOAD_CAP`
  stops 8 bytes short — no existing offset moved, nothing re-learns the
  layout. Layout comment in kernel.js + KERNEL.md section updated.
- The advertise flag is written at spawn, before the worker exists, so
  host.js can read it once at SDL-backend construction — no handshake,
  no race. `Kernel({vsync: true})` is the embedder declaration;
  kernel-worker passes it, boot.js doesn't.
- `KernelClient.vsyncWait` tracks the last-delivered seq: a tick that
  landed while the frame callback ran resolves the next wait
  immediately (rAF catch-up semantics) instead of waiting a full extra
  frame — without this, any callback longer than one vsync period would
  halve the frame rate again, the exact bug class we just fixed.
- The wait surfaces through the existing spawnHooks seam as the surface
  backend's `requestAnimationFrame`, so the frame-loop driver in
  runModule needed zero changes — the third pacing tier slotted into
  the seam the first two already share.
- `vsyncTick()` sits at the very top of the compositor's `draw()`,
  before the degenerate-canvas early return, so pacing survives frames
  the compositor itself skips.
- Known edge (accepted): an app that clears its frame func (SDL_Quit)
  right as the clock stops finishes its exit handshake on the next
  tick — i.e. when the tab becomes visible again. Consistent with
  stop-when-hidden; SIGKILL/worker-terminate is unaffected.
