# #484 — GPU present transport backpressure: clamp presents at the producer

## The bug (P0, tab-crash class; GAMEDEV-EPIC foundation ticket 1)

A legal poll-only SDL3 render loop — `while (running) { while (SDL_PollEvent)
...; update; render; SDL_RenderPresent; }`, no `SDL_Delay` anywhere, the most
common game main loop in existence — kills the browser tab. In the browser
flavor every present is a fresh `canvas.transferToImageBitmap()` (~1.2 MB GPU
bitmap at 640x480) plus a fire-and-forget `postMessage` to the kernel worker.
The kernel's latest-frame-wins close (`_wmFrame`) runs at CONSUME time, so the
in-flight message queue was unbounded: the loop presents as fast as it spins
(~2,100/s originally measured; **~7,991/s** re-measured on this lane's
`pollball` under the headless in-process kernel), the GPU process eats
gigabytes per second of bitmap churn, device loss follows within seconds, and
the compositor — the entire gucOS canvas — dies with it. The Node/shm path
writes into a fixed double buffer (no per-present allocation) and survives the
same flood indefinitely: browser-transport-only.

## The fix — mailbox newest-wins enforced at the PRODUCER seam

`host.js` browser flavor, `presentTo` (the one choke both GPU tails cross:
the SDL_Renderer flush via `presentFrame`, and raw webgpu.h presents via
`webgpuConfig.bindWindow().present()`):

- **At most one `transferToImageBitmap` per kernel vsync tick.** The tick
  counter is already on every kernel page (`KP_VSYNC_SEQ`, todos/0100/0167);
  a new `spawnHooks.vsyncSeq()` reads it synchronously (kernel.js — a plain
  atomic load, never a park). Same tick as the last shipped present → the
  present ships nothing. No advertisement (vsync-less embedders) → an 8 ms
  wall-clock interval instead (~125 fps cap; still bounded because the
  consumer drains the whole queue per composite).
- **The clamped frame is HELD, never lost.** The canvas still holds exactly
  that frame, so the newest clamped present is remembered per sid and
  re-ships: through the gate at `SDL_PollEvent`'s pump (#485's `__sdl_pump` —
  a hot loop stays clamped, but a loop that stops presenting still gets its
  last frame out on the next tick), or unconditionally at the park seams
  (`pumpWait`/`waitMulti` entry — an app going quiet must not leave a stale
  frame on screen; one frame per park cannot flood). The park flush is
  same-JS-task with the clamped present (blocking apps never turn the event
  loop between them), so the canvas content is exactly the clamped frame.
- **A present that acks a pending resize always ships** — the ack is a
  protocol step (`surfaceConfigure` renegotiation, todos/0019), not just
  pixels; clamping it would stall the resize handshake behind the next tick.
- Clamp state dies with the sid at `__sdl_destroy_window`.

Why per-tick gating cannot deadlock against the on-demand compositor
(todos/0169): every SHIPPED frame is damage that unparks the compositor
(`_wmFrame` arms unconditionally), and every composite bumps the tick — so
after any tick bump exactly one present ships, which schedules the next
composite. Steady state is one present per composite; hidden tab = no ticks =
presents drop after the first (bounded, the honest pause — same discipline as
`vsyncWait`-paced apps).

Semantics are unchanged (mailbox, newest wins — SDL3's default present mode
on this transport); the queue physically cannot grow. Paced apps are
unaffected: one present per frame at ≤ vsync always lands on a fresh tick, and
the rare same-tick double-present coalesces and re-ships at the app's next
park, so nothing is ever lost.

## New surface

- `os/pollball.c` → demos package v3 (`/usr/local/bin/pollball`, Demos menu):
  the GAMEDEV-EPIC repro as a permanent demo/acceptance app — poll-only
  bouncing ball, wall-clock movement, ESC/close quits, prints
  `pollball: quit` on the way out. Deliberately no Delay/WaitEvent; it is the
  living acceptance for #485 (input reaches a poll loop) and #484 (the loop
  cannot kill the tab).
- `wmctl seq SID` (os/wmctl.c): prints the kernel-side frame counter
  (`SH_SEQ`, bumped per consumed frame). Two reads a known interval apart =
  the present rate the kernel actually observed — the acceptance instrument.
  `wmctl list` columns untouched (~30 tests parse them).
- `tests/browser/os-pollball.mjs` (sweep member 51): composites, animates,
  kernel-observed rate bounded to 15..300/s over a ~4 s window (clamped ~60;
  unclamped floods measure in the thousands), close-box quits cleanly, shell
  alive after. This is the ticket's "present-rate counter" leg.

## Verification done on this lane (heavy gate still owed — lock stand-down)

- `pollball.c` and `wmctl.c` compile with our compiler; the pollball wasm
  imports `__sdl_create_renderer` (so runModule awaits the GPU renderer).
- Ad-hoc in-process kernel run (headless/shm, worker_threads): window up,
  frameSeq 8324→16315 over 1 s (~7,991 presents/s — the flood, unclamped
  headless BY DESIGN), `WMEV_QUIT` → clean exit 0, `pollball: quit`.
- Delay-paced smoke through the edited park seams: clean exit.
- `tools/mkpkg.js` (private out+pool per the 0388 isolation rules): demos v3
  builds, payload carries `opt/demos/pollball`, minBase 236.
- **Fake-driven clamp harness** (Node, fake OffscreenCanvas/navigator.gpu/
  hooks; throwaway, not committed): 8/8 —
  flood-in-one-tick ships exactly 1 bitmap; next tick ships exactly 1 more;
  park entry flushes the held trailing frame, second park ships nothing;
  `__sdl_pump` holds on the same tick and ships on a new one; a paced
  one-present-per-tick app ships all 10/10; destroy clears state.
- **Red control (Node level), prediction stated in advance:** with
  origin/main's host.js (clamp absent), leg 1 would fail with
  `frames=1000 bitmaps=1000`. Ran it (git stash of host.js): exactly that —
  `FAIL flood in one tick ships exactly 1 frame  frames=1000 bitmaps=1000`,
  5 legs failed, exit 1. Restored; harness green again.
- **Red control (browser level), planned for the gate:** revert the presentTo
  clamp, run os-pollball.mjs — prediction: the rate leg fails loudly
  (rate ≫ 300/s), and the tab may die outright taking later legs with it.

## Bookkeeping

- `os/image.json` 235 → **236** (wmctl.c is a baked seeded source).
- `packages/demos.json` version 2 → **3** (+pollball file/bin/menu).
- Expected gate totals move: browser sweep **50 → 51** members
  (os-pollball.mjs joins discovery); kernel stays 157.
- No new liability-register entries (no described-but-unscheduled gaps).

## Gate results (2026-08-04, after lock release)

- Merged origin/main (884b78d9, #486 hung-app contain) first — kernel.js
  auto-merged CLEAN; interaction read: #486 judges "responding" by input-ring
  rpos advancement, #484 touches only the present path and `__sdl_pump` still
  drains the ring every SDL_PollEvent, so a clamped poll loop is correctly
  alive and a wedged app still force-quits. image.json stayed 236 after the
  3-way (verified — not the #485 counter trap). Merge commit 21eafc98.
- **Full diff gate** (`tests/run.js --diff origin/main`, all suites, 3150s):
  todos/unit/blockfs/py×17 green; **kernel 157/157** (done, filter null,
  recorded==total, all pass); **sweep 51/51** — os-pollball.mjs joined
  discovery and passed, clamped rate leg green. ONE red: host —
  `test_gpu_present_binding.js` 3 legs, a pre-clamp fake flavor with no
  vsync hooks whose back-to-back presents the new clamp's clock fallback
  held (`[]` = frame held, not lost — the clamp working against a test
  written before it existed).
- **Repair** (@4b4c87ae): the binding test's subject is per-window binding,
  not rate — its fake hooks now advertise a tick bumped before each present
  that must ship; 15/15. The lane's throwaway clamp harness promoted to
  `tests/host/test_gpu_present_clamp.js` (host members +1), 11/11.
- **Host delta gate** (`--diff 21eafc98` → plan: host only): exit 0,
  "All host tests passed", 636 ok / 0 FAIL. (This replaced
  build/test-run/summary.json; the full-gate roll-up is preserved out of
  tree and its kernel/browser artifacts are byte-identical on disk.)
- **Browser red control, predicted in advance** (origin/main host.js, real
  Chromium): rate leg FAILED at **72,719 presents/s** kernel-observed
  (seq 47,012→340,579 over 4s) — and the desktop never repainted after the
  app quit (probe read 0,0,0: the compositor died under the flood, the
  tab-crash class live on camera). Restored tree: **8/8 green, 82/s**
  clamped — an ~887x reduction at the same app.
