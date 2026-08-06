# #551 — sustained SDL play killed the compositor: root cause, fix, and what the probes ruled out

Ticket #551 (P0, jku next-up promotion): jku's in-OS SDL3 game ("Keep Up",
`RenderPresent` + `SDL_Delay(1)` loop) killed the ENTIRE browser desktop after
~2 min — `[compositor] WebGPU device lost: Device was destroyed.`, every pixel
black, no recovery, game process still running.

## The mechanism, measured (not guessed)

Instrumented counters (presents vs `transferToImageBitmap` ships) + OS-free
probes (a plain page + workers replica of the producer→kernel shape) pinned it:

| run | present rate | ship rate | death (game time) | ships at death |
|---|---|---|---|---|
| keepup `SDL_Delay(1)` | ~160/s | ~160/s | ~103 s | ~16.5 k |
| keepup poll-only | ~1870/s | ~64/s | ~251 s | ~16.3 k |
| probe, blocked producer | — | ~200/s | — | 16,744 |
| probe, blocked + canvas rotation | — | ~200/s | — | 16,741 |
| probe, yielding producer (any shape) | — | ~300–500/s | none | >60,000 clean |

1. **The #484 producer clamp was void for delay-loop games.** `flushPresent`'s
   park-entry flush shipped the held frame UNCONDITIONALLY, and `SDL_Delay(1)`
   parks hundreds of times a second — so ships == presents, not ≤ vsync.
2. **Chromium budgets a never-yielding worker ~16.7k lifetime
   `transferToImageBitmap` ships** (16,744±3 across probes). Every OS SDL /
   webgpu.h frame loop parks in `Atomics.wait` and never returns to its event
   loop, where the bitmap recycle/return tasks would run. The budget is
   rate-independent, close-discipline-independent, canvas-rotation-proof, and
   consumed only by blocked producers. At exhaustion Chromium destroys the
   KERNEL worker's device (`reason=destroyed`) — the other worker's device is
   the casualty, matching the observed symptom exactly.
3. **Past the wall the producer's canvas ships dead (transparent) frames
   forever** — so even a recovered compositor shows a ghost window; and there
   is **no synchronous GPU-pixel export from a blocked worker at all**
   (`drawImage(webgpuCanvas)` reads black: canvas image publication also needs
   the event loop; every readback API is a promise).
4. Exonerated along the way: per-present encode/submit churn (462k encodes,
   no death), title/label churn (idle control, prior thread), ImageBitmap
   close discipline in `_wmFrame` (correct), the compositor label cache
   (bounded), kernel-side import counts (not invariant at death).

The wall also appears to be one-shot per session (probe ran 25k ships past a
recovered device, clean), but the fix does not lean on that.

## The fix (three legs, all landed)

- **(A) `flushPresent` mode split** (host.js): 'gate' (poll pump, unchanged),
  'force' (real parks ≥15ms/indefinite — unconditional, self-limiting),
  'park' (short-timeout parks — keep the vsync gate, 17ms wall-clock escape
  for stalled ticks so a parked compositor still gets its wake). Measured:
  gpubox ships ratio 1.000/frame; pre-fix keepup measured 2.7.
- **(B) compositor device-loss recovery** (os/compositor.js): all
  device-derived state rebuilds via `initGpuState`; `device.lost` logs loudly
  (reason included) and re-acquires with backoff; shm surfaces re-upload from
  SABs, gpu surfaces re-import the kernel-held bitmap, labels re-rasterize.
  `compositor-kill` test hook drives the REAL lost path; recovery measured at
  attempt 1–2, sub-second. Loud-by-design (0055) was a boot rule; a running
  OS survives transient loss now.
- **(C+O4) OS SDL_Render\* apps rasterize software→shm** (host.js): the
  A4-era GPU renderer lock-in reverted for the OS worker flavor — with a
  ~16.7k lifetime budget and no sound export path, GPU-rendered pixels
  cannot leave a blocked worker; the software tier (every headless kernel
  e2e's tier) has zero per-present GPU objects, so the wall is unreachable
  for the gamedev-epic app class. Standalone pages keep the GPU renderer
  (sound there). The per-process SDL device got a loud lost logger.

**Proof**: the byte-identical Keep Up repro ran 11.2 min continuous with
zero device losses, zero blips, `wmFrames=0` (no GPU bitmaps at all), window
and desktop alive throughout — vs death at 103 s before. Regression gate:
`tests/browser/os-devloss.mjs` (zero-ships invariant, gpubox vsync-clamp
ratio, synthetic `device.destroy()` → recovery with pixel-verified repaint).
`os-pollball.mjs` re-cut: its 15..300/s band measured the retired GPU
transport; shm flips are unbounded by design (8229/s measured, compositor
still samples at its own rAF).

## What #551 changes about #484's contract — all three places, one statement

#484's contract was "at most one bitmap ship per vsync tick, and the freshest
frame is never lost: held frames flush unconditionally at every park seam."
The second half is what #551 retires — the park seam recurs hundreds of times
a second in a `SDL_Delay(1)` loop, so the unconditional flush made
ships == presents and burned the blocked-worker budget. The contract change
lands in three places, deliberately:

1. **`host.js` `flushPresent`** — the mode split. 'gate' (poll pump) is
   unchanged; 'force' keeps the unconditional flush but ONLY for real parks
   (≥15 ms timeout or indefinite — self-limiting, and the parking app may
   never present again, so its freshest frame must land); 'park'
   (short-timeout parks, the delay-loop shape) keeps the vsync gate with a
   17 ms wall-clock escape so stalled ticks (parked compositor, hidden tab)
   still get the ship whose damage re-wakes them. Freshest-frame-never-lost
   still holds — the bound moved from "immediately at any park" to "within
   one tick / 17 ms".
2. **`tests/host/test_gpu_present_clamp.js`** — re-cut to that contract
   (12 → 14 assertions). The three park legs re-point from
   `__sdl_pump_wait(0)` to `(1000)` (a REAL park) with predicates preserved;
   two NEW legs pin the short-park clamp: held within the tick + 17 ms wall
   window (self-measured trial, the 7b pattern, so it cannot flake under
   load) and shipped once the tick advances.
3. **`tests/browser/os-pollball.mjs`** — the present-rate leg LOST ITS
   CEILING: `rate > 15 && rate < 300` became `rate > 15`. Stated plainly:
   this is a weakened assertion, on purpose. The 15..300/s band measured the
   GPU transport's ship rate, a resource that no longer exists on this path —
   OS SDL_Render* apps now flip the shm SAB, where a poll-only loop runs at
   its own pace by design (8,229 flips/s measured; the compositor still
   samples seq-gated at its own rAF). The floor is load-safe per #444: a
   lower bound only slackens in the accepted direction. The ship-rate
   ceiling did not vanish from the estate — it moved to
   `os-devloss.mjs`, which asserts the surviving gpu transport (webgpu.h)
   at ships ≤ ~1 per composited frame AND that renderer apps ship zero.

## The software-rasterization cost, measured

The A4-era GPU renderer in OS workers was UNSOUND, not merely expensive —
a blocked worker's GPU pixels cannot leave the worker at all (no sync
readback, no sync canvas snapshot, and `transferToImageBitmap` carries the
~16.7k lifetime budget), so no amount of clamping makes it correct. What
correctness costs, same app, same machine, same 800×600 scene (Keep Up,
poll-only, rate measured at the kernel's frameSeq):

| tier | rate | per-frame |
|---|---|---|
| GPU renderer encode (probe E2b, pre-#551) | ~1,870/s | ~0.53 ms |
| software rasterize + shm flip (this branch) | 953/s | ~1.05 ms |

So software costs ~0.5 ms/frame more at 800×600 — ~6% of a 60 fps frame
budget — and a paced game loop (the actual shipped shape; Keep Up runs
~160 presents/s delay-bound) is completely unaffected: both tiers idle
through the delay. pollball at 320×240 does 8,229 flips/s (~0.12 ms/frame).
The GPU number above bought a dead desktop at ~103 s; the software number
is the flagship path now and runs indefinitely.

## Residual + follow-ups (filed on #551)

- **webgpu.h apps (gpubox class) still burn budget** at ≤60 ships/s → freeze
  as a ghost window after ~4.6 min of continuous presenting, desktop
  recovering fine. Structural fixes are architecture-scale, deliberately not
  landed under a P0: **presenter-worker** (a yielding sibling owns
  device+canvas, executes the draw stream — restores first-class GPU 2D) or
  **JSPI** (suspend the wasm frame at park imports so the worker genuinely
  yields — un-breaks the whole blocked-worker-vs-async-browser-API class,
  including in-process device recovery and mapAsync).
- Stability finding (jku's directive): any design that requires a browser
  async round-trip from a process worker is dead on arrival — the blocked
  main loop is legal and common. The presenter/JSPI decision should be made
  once, as a design, not per-feature.
