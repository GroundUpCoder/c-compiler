# IDLE-POWER — on-demand rendering: a truly-idle gucOS desktop

**Status**: proposal, revised 2026-07-12 after an adversarial code-verification
review (four independent verification passes over host.js/kernel.js/
compositor.js/wm.c + git archaeology of the reverted 0160 attempt). The
original 2026-07-12 draft had one false factual premise, one wrong wake
primitive, a load-bearing scope omission, and four wake-coverage holes — all
folded in below. Not yet queued.
**Owns**: the unifying design behind todos/0160, todos/0161, and the new
pieces (browser vsync-shim wiring; on-demand compositor; wm.c event-driven
conversion). Read this before touching any of them.

## TL;DR

Opening a few windows makes the machine hot because gucOS is **clock-driven,
not event-driven**: everything runs at 60 fps whether or not anything changed.
Two compounding costs, both verified in the code:

1. **The compositor re-renders the whole screen every rAF.** `os/compositor.js`
   `draw()` ends with an unconditional `requestAnimationFrame(draw)` (~578)
   and always submits a full WebGPU pass over *all* mapped surfaces
   (~414-471). Only the per-surface texture *upload* is seq-gated; the
   *submit* is not.
2. **Every app worker wakes ~60×/sec even when idle — but NOT the way the
   first draft said.** Review finding: **todos/0100's vsyncWait pacing was
   never wired into host.js's BROWSER SDL flavor.** The
   `hooks.vsyncWait().then(cb)` shim (host.js ~6156) lives only in the
   headless/shm flavor's return object; the browser flavor returns earlier
   (~6135) inheriting `createBrowserSDL`'s try-rAF → NotSupportedError →
   deadline-setTimeout latch. And headless kernels never advertise vsync. So
   the shim is dead code everywhere: **no process ever parks on
   `KP_VSYNC_SEQ`; `vsyncTick()`'s per-pcb notify wakes nobody.** Browser app
   workers wake *themselves* via setTimeout ~60×/s. Same heat, different
   mechanism — and KERNEL.md/CLAUDE.md's "tab hidden = SDL apps park" is
   currently intent, not code (hidden tabs throttle timers to ~1 Hz; apps
   slow down, they don't park). Wiring the shim into the browser flavor is
   **Stage 1** below, a prerequisite for everything else.

Real compositors (Wayland/Weston, macOS WindowServer, Windows DWM) are
**event- and damage-driven**: idle clients block on an fd/port and cost
nothing; the compositor recomposites only on a surface commit, input, or an
active animation. **vsync is a throttle for animating clients, not a global
heartbeat.** This doc specifies how to get there and argues the correctness.

## The linchpin fact — verified, with two amendments

Verified: `shmPresent` (host.js:5940-5960) is SAB-only in steady state —
`Atomics.store(WMSH_FLIP)` + `Atomics.add(WMSH_SEQ)`, no notify, no message;
the compositor learns about shm presents only by polling `WMSH_SEQ` per frame
(compositor.js ~284-307), and nothing anywhere waits on the framebuffer SAB.
(One irrelevant exception: the first present at a renegotiated size calls
`ackConfigure` → a wm-sabs postMessage + SURFACE_CONFIGURE RPC.) So a parked
compositor does need a new wake for shm presents. Amendments from review:

- **GPU-transport presents ALREADY message the kernel worker.** Every gpu
  present is a `{type:'wm-frame'}` postMessage (host.js ~6053-6065 →
  kernel.js:999, handled at kernel.js:1907 `_wmFrame`). The gpu doorbell is
  one unconditional `scheduleFrame()` call in `_wmFrame` — free insurance;
  today `_wmFrame` stores the bitmap and bumps SH_SEQ with no wake.
- **The invisible-presenter class is bigger than "apps that stop calling
  rAF".** user32/pumpWait apps never touch the rAF shim at all: `GetMessage`
  is a chunked `__sdl_pump_wait(25)` poll (os/win32/user32.c ~2243-2266) and
  repaints happen from inside it — winmine's 1 Hz `SetTimer` counter,
  notepad's caret blink, term redrawing on pty output — presenting SAB-only,
  forever, independent of vsync. **Therefore the doorbell must ring on
  PRESENT-while-parked, not only on rAF-arm** (piece B). No finite grace
  coast covers a recurring timer.

## How real OSes draw (the target model)

- **Idle clients cost zero.** A client blocks on its event source
  (`wl_display` fd, `GetMessage`, the runloop). No draw, no wake. Piece C.
- **Composite only on damage.** A surface commit carries a damage signal;
  the compositor wakes, recomposites, presents, sleeps. Pieces A+B.
- **Frame callbacks are opt-in.** Wayland `wl_surface.frame` = "tick me next
  frame if I ask." vsync paces animating clients only. The (Stage-1-wired)
  vsyncWait IS this.
- **Occlusion culling / damage rects / overlay planes.** Follow-on
  efficiency, not required for idle-zero (review confirmed: every hole found
  was a *wake* bug, not a *what-to-redraw* bug).

## The proposal: five pieces, all required for idle-zero

- **Stage 1 (prereq). Wire the vsyncWait shim into the browser flavor.**
  `out.requestAnimationFrame = (vsyncEnabled) ? cb => hooks.vsyncWait().then(cb) : inherited`
  at the browser flavor's return (host.js ~6129). Makes 0100's documented
  behavior true, makes "hidden tab parks" real, and gives piece B's doorbell
  a live call site. Independently testable; no compositor change.

- **A. On-demand compositor** (os/compositor.js). `draw()` computes
  **dirty** = (any surface `WMSH_SEQ`/bitmap changed) OR (`_wmVersion`
  changed) OR (any compositor animation active). If dirty: composite +
  submit. Re-arm rAF iff `keepAlive` OR within a short GRACE coast. Else
  park (`armed = false`). While armed, call `vsyncTick()` unchanged. Expose
  `scheduleFrame()` (arms iff `!armed`). Amendments from review:
  - `keepAlive` = any `wantFrame` OR **any registered vsync waiter** (the
    ARMED word, piece B) OR anim active.
  - The compositor's OWN animations are **only** the minimize/restore fly
    records in `scene.anims`. `wmScene()` prunes expired records at read
    with no bump (kernel.js ~4173) — decide park only from the post-prune
    scene of a frame you already drew, so the final post-anim state renders.
  - GRACE is an **optimization only** (correctness holds at GRACE=0 given
    B); count it in armed `draw()` frames, not wall-clock, so it suspends
    cleanly with the hidden-tab rAF stop.

- **B. Wake plumbing — the correctness core** (kernel.js, kernel-worker.js,
  host.js). The first draft's doorbell-on-rAF-arm provably deadlocks a
  never-idle app (`Atomics.waitAsync` registration is passive; the kernel
  cannot see "an app just started waiting"; interleaving: app is mid-frame-
  callback when the last armed draw ticks + parks → catch-up resolves one
  more frame → app presents SAB-only → waitAsync forever, no doorbell — a
  frozen APP: no input drain, no cooperative signals, SIGKILL-only). The
  protocol that closes it:
  - Two new per-pcb kernel-page TAIL words: `KP_VSYNC_ARMED` (waiter count)
    and `KP_COMP_PARKED` (parked flag). Payload cap shrinks 8 more bytes —
    mechanical (test_sockets derives its clamp from the exported constant);
    keep KERNEL.md's layout comment + tests in sync.
  - Shim side: `Atomics.add(ARMED, 1)` **before** `waitAsync`, then
    `Atomics.load(PARKED)`; if parked → post `{type:'want-frame'}`.
    Decrement ARMED on resolve.
  - **Doorbell-on-present**: `shmPresent` (and the Dawn shm twin, host.js
    ~6177-6191): after the `WMSH_SEQ` bump, `Atomics.load(PARKED)`; if set →
    post want-frame. Covers the pumpWait/WM_TIMER class; animating games pay
    one atomic load per present.
  - `_wmFrame` (gpu presents): `scheduleFrame()` unconditionally.
  - Park decision is Dekker store-then-check: store `PARKED=1` on every pcb
    page FIRST, *then* re-read every ARMED/wantFrame and every `WMSH_SEQ`;
    any hit → `PARKED=0`, stay armed. Seq-cst atomics make a lost waiter or
    lost present impossible.
  - `wantFrame` is hard state, never heuristic: set on doorbell, cleared
    ONLY by explicit WaitEvent entry (posted before `pumpWait` blocks) and
    by process reap (a crashed animating app must not pin the compositor);
    stamped at spawn-while-parked (the `KP_VSYNC_EN` precedent,
    kernel.js:1759).
  - Route the **20** `_wmVersion++` sites (recounted — not 21) through one
    `_bumpWmVersion()` → dirty + `scheduleFrame()`. Kernel-worker handlers
    `wm-input`, `screen-resize`, `wm-canvas`, **`drop-file`**, and
    **`wm-frame`** all `scheduleFrame()`.
  - The parked kernel worker processes all of this normally — verified: the
    kernel side never blocks synchronously (all sync `Atomics.wait`s in
    kernel.js are process-side); its loop is onmessage + the audio interval
    + rAF-when-armed. Doorbell latency = event-queue depth (worst case,
    behind a long COMPILE — delay, never loss).
  - **P0 prerequisite (pre-existing kernel bug, land first, standalone):**
    `wmFocus` raises without bumping (kernel.js:3746-3751 — the z-raise is
    unconditional, the bump is gated on a focus *change*; `wmctl lower
    <focused-sid>` then `wmctl focus <sid>` reorders z with no bump, no
    input, no present). One-poll-frame staleness today; frozen screen +
    hit-test/pixel disagreement under parking. Fix = bump when the reorder
    branch fires, + regression test.

- **C. Idle apps stop producing frames** (todos/0161). Seam verified:
  `pumpWait` drains the input ring into the same wasm-side event queue
  `SDL_PollEvent` pops (host.js ~5963-6018 → `__sdl_push_*`; compiler.js
  `__sdl_eq_head`), so `SDL_WaitEventTimeout` is cleanly
  `loop { if (PollEvent) return; __sdl_pump_wait(remaining) }` — the
  `Atomics.wait` timeout form is already used at host.js ~6036. Infinite
  `SDL_WaitEvent` chunks the int-ms import. An app in WaitEvent drops its
  `wantFrame`. **mgp stays the first proof adopter** (settled, no
  `%pause`/fly-in → WaitEvent). NB the SDL veneer in compiler.js is a JS
  **template literal** — no backticks/`${}` in C comments.

- **W. wm.c goes event-driven — REQUIRED, not an incremental adopter** (the
  review's biggest scope correction; the first draft's "minimal set" fails
  its own acceptance without this). `/bin/wm` is the ONLY always-running SDL
  app on an idle desktop (sole `kernel.service`; pid-1 hush blocks on tty)
  and is a frame-callback app (`__setAnimationFrameFunc(frame_cb)`,
  os/wm.c:3767). With only the piece-D present *gate* it still wants frames
  every tick → `keepAlive` never falls → **nothing ever parks**. And once
  parking works, a frame-callback wm means: the screensaver **never raises
  on an idle system** (the 1 Hz GET_IDLE poll runs off `frame_cb` — idle is
  exactly when it must fire), the taskbar clock freezes, the
  `desk_load`/recycle-glyph coarse polls stop (stale icons after any
  external fs mutation, including `drop-file`). Conversion: `frame_cb` →
  a `SDL_WaitEventTimeout(…, 1000)` loop; frame-tick counters (`desk_load`,
  saver poll, PEEK_IDLE/PEEK_REFRESH) → wall-clock; menu/ctx/run columns
  redraw on-change instead of every frame (only `draw_desk` is dirty-gated
  today); screensaver marquee/starfield and other wm-rendered animations
  stay on the frame-paced path while active (they are ordinary app presents
  — the first draft's wake table mislabeled them "compositor's own
  animations").
  **Plus kernel plumbing in no earlier scope row:** `pumpWait` parks on the
  input ring only, but wm's events (EV_CREATED, EV_SNAP_EDGE during another
  window's title drag, EV_SCREEN, R_IDLE…) arrive on the **WMP socket** —
  kernel socket delivery to a wait-parked subscriber must also notify its
  input ring, or the taskbar/snap preview lags up to 1 s. (Precedent that
  this bites: user32's "blocking" GetMessage chunks at 25 ms for exactly
  this — its agent socket. The same plumbing eventually lets user32 stop
  chunking; not required for the first pass.)

- **D. Taskbar present gate** (os/wm.c). The reverted attempt's
  `bar_present()` content-memcmp (29 LOC, recoverable from `659902d`) —
  present the bar only when content changes. Handles present-*churn* only;
  parking needs W. Avoid the global `shmPresent` memcmp alternative
  (taxes every animating app).

**Dependency:** Stage 1 enables B's shim-side doorbell; A+B can't win
without C+W (wm alone keeps it awake); C+W without A+B leaves the 60 Hz
compositor heartbeat. The set that zeroes both headline scenarios (settled
mgp slide AND idle desktop) is Stage1 + A + B + C1 + C2(mgp) + W + D.

## Correctness: complete wake coverage (revised table)

The failure mode is a missed wake ⇒ frozen screen (or, worse, frozen app —
see B). Coverage:

| Damage source | Wake hook |
|---|---|
| Pointer / key / wheel input | kernel-worker `wm-input` → `scheduleFrame()` |
| Screen resize / canvas swap | `screen-resize` / `wm-canvas` → `scheduleFrame()` (NB there is NO VT-switch message type — a switch doesn't change the scene; the first draft's row was fiction) |
| Any WM/geometry/z/focus/map/title/glass/dst/layer/anim-start op | `_bumpWmVersion()` (all **20** sites, incl. the fixed `wmFocus` raise) → `scheduleFrame()`. Includes the WM_MAP_TIMEOUT setTimeout path — hook 3 must actively arm rAF, no message accompanies it |
| shm app present | **doorbell-on-present** (PARKED-gated in `shmPresent` + Dawn twin) |
| gpu app present | existing `wm-frame` message → `scheduleFrame()` in `_wmFrame` |
| App arming a vsync wait | ARMED word + doorbell-on-arm-while-parked (Dekker check at park) |
| Host file drop | `drop-file` handler → `scheduleFrame()` (+ W: wm notices via its own loop, not a 60-tick frame poll) |
| Compositor's OWN anims (minimize/restore fly records only) | keepAlive while active; park decided from the post-prune scene of an already-drawn frame |
| wm.c-rendered animations (screensaver, peek/datepop, snap preview, menus) | ordinary app presents — doorbell-on-present + wm stays frame-paced while animating |

Belt-and-suspenders (keep): always submit + reset idle on the first frame
after any create/destroy/resize/DST/layer op and after a swap-chain
reconfigure; when unsure, submit. GRACE coast = cheap churn absorber, not a
correctness mechanism.

**Do NOT add a timeout to `vsyncWait`** as a safety net — it would break the
hidden-tab honest pause (KERNEL.md stop-when-the-clock-stops). Fix wake
coverage instead; that's what the ARMED/PARKED protocol is for.

### Honest caveat on "zero"

- **audioPump is a permanent 50 wakes/sec floor** on the kernel worker
  (`setInterval(audioPump, 20)`, kernel-worker.js ~379) — gate the interval
  on a live-stream count (small, in scope) or the idle-zero claim is false
  at the kernel-worker level.
- wm.c wakes 1×/sec (`WaitEventTimeout(1000)`: clock + GET_IDLE saver poll);
  the clock repaints once a minute. Matches real OSes.
- Still a full-screen recomposite when dirty; damage rects + occlusion
  culling are follow-on efficiency, not correctness (review-confirmed).

## Prerequisites already due on main (P0, land before any branch)

1. **kernel.js `wmFocus` raise-without-bump** (see B). Latent staleness bug
   today, frozen-screen bug under parking. One-liner + test.
2. **`test_wm_service_e2e`: 3 legs fail on clean main** (dblclick-on-term,
   `.icons` layout, Ctrl+A) — deterministic, NOT flake: `DESK_ENTRIES`
   (tests/kernel/test_wm_service_e2e.js:79-80) hardcodes 7 launchers and
   omits the notepad icon added by `785eca2`; same class todos/0164 fixed
   for recycle (derive from live state). This also **answers the 0160
   deferral note's open triage**: the recycle failures were fixed by 0164;
   the wm_service failures are this pre-existing hardcode, unrelated to the
   0160 attempt. Must land first or any re-land re-flags the same 3 and
   muddies its own verdict.

## Change scope estimate — revised (~550–850 LOC, ~9–10 files)

The reverted attempt (`659902d`) cost ~108 LOC of product code across 4
files + a 143-line test, and was reverted for *direction* (the taskbar-
coupling scope realization + then-unresolved triage), not correctness — it
passed its own acceptance 11/11. Per-piece the first draft was honest; the
revision adds what it omitted:

| Piece | Files | ~LOC | Zero? |
|---|---|---|---|
| P0 prereqs (wmFocus bump; DESK_ENTRIES derive) | kernel.js, tests | 25–45 | correctness, land first |
| Stage 1: browser vsync-shim wiring | host.js | 10–20 | ✅ prereq |
| A. On-demand compositor | os/compositor.js | 60–100 | ✅ |
| B. Wake plumbing (tail words, Dekker park, doorbell-on-present, `_bumpWmVersion`, handler wires) | kernel.js, kernel-worker.js, host.js | 80–130 (+ mechanical rename) | ✅ |
| C1. `SDL_WaitEvent`/`WaitEventTimeout` | compiler.js (SDL template literal — no backticks/`${}`), host.js | 100–170 | ✅ |
| C2. mgp first adopter | vendor/magicpoint/mgp.c | ~15 | ✅ (proof) |
| W. wm.c event-driven conversion + WMP-socket→input-ring notify | os/wm.c, kernel.js | 170–300 | ✅ (the risk concentration: wm.c is 3.8k lines behind the most timing-sensitive e2e surface in the repo) |
| D. Taskbar present gate | os/wm.c | ~25 | ✅ |
| E. Tests: resurrect `os-compositor.mjs` + submit/wake counters (probe surface is product code) + flake gate | tests, kernel.js/host.js probes | 180–210 | correctness |
| audioPump live-stream gate (pulled forward — lands pre-Stage-3, standalone) | os/kernel-worker.js | ~10 | honest-zero |
| Incremental adopters (term, fileman, notepad; doom/quake/gpubox stay poll-loop) | per app | 10–30 each | polish |

## Acceptance

- A static screen (settled mgp slide; idle desktop) issues **no** GPU
  submits and **no** per-frame app-worker wakeups after settling — verified
  by submit + wake counters. The wake counter measures **app-worker** wakes
  and GPU submits; the audioPump interval is gated/measured separately.
- Every real change still repaints within one frame: move/resize/close,
  focus (incl. raise-only focus — the wmFocus fix's regression case), menu,
  cursor-driven app changes, shm present, gpu present, WM_TIMER repaint
  (winmine counter ticking while parked), drop-file, every compositor and
  wm-rendered animation, **and the screensaver still raises after idle
  timeout on a fully-parked desktop** (the W acceptance case).
- Hidden tab parks everything — now actually true (Stage 1). **Assertion
  strategy (decided up front, 2026-07-14): probe-based, not a real hidden
  tab.** Playwright disables background throttling/occlusion in both
  headless flavors — a backgrounded tab stays `visibilityState==='visible'`
  with worker rAF ticking ~67/s, so no automated leg can hide the tab for
  real. The automated assertion is the Stage-4 wake/submit counters plus a
  synthetic vsync-stop (test flag stops `vsyncTick()`; assert app-worker
  wake counters go flat); the true hidden-tab behavior stays a
  headed-browser manual check on the WM.md "Known issues" per-round list.
- Browser os-sweep visual legs unchanged. Run `tests/flake.js` at Stages 1,
  3, 4 (frame loop + input-wake path).
- Measure idle CPU%/GPU + worker-wakeups/sec before/after (static VT2
  desktop; then with 3–4 windows) — the thermal claim must be shown.

## Resolved questions (review verdicts on the first draft's open questions)

1. **Doorbell shape**: hybrid REQUIRED, not either/or — postMessage for the
   wake (cheap, only transitioning apps pay), SAB words (ARMED/PARKED) for
   the park decision. Parked-kernel-worker delivery confirmed (idle event
   loop; kernel never sync-blocks).
2. **vsyncTick while parked**: broken as originally posed (doorbell-on-arm
   alone freezes a never-idle app — interleaving in B); race-free with the
   ARMED-before-waitAsync + PARKED store-then-check protocol. A vsync-parked
   victim is a frozen app, not just a stale screen — hence no shortcuts.
3. **GRACE**: armed frames, not wall-clock; 2–3 frames; optimization only.
4. **Taskbar gate**: (a) `bar_present()` + (c) WaitEvent — confirmed, with
   the correction that (a) alone only stops churn; parking needs W.
5. **Scope discipline**: confirmed — damage rects and occlusion culling stay
   OUT (every review hole was a wake bug; full recomposite-when-dirty has no
   correctness exposure).
6. **Sequencing**: STAGE IT (below). The one-branch "minimal set" of the
   first draft fails its own acceptance (no W ⇒ nothing parks).

## Staging plan

- **Stage 0** (now, P0s): wmFocus bump fix; DESK_ENTRIES derive-from-live.
- **Stage 1**: browser vsync-shim wiring (makes 0100/KERNEL.md true; hidden-
  tab park becomes real and testable). Flake gate. **DONE 2026-07-13
  (todos/0167).**
- **Stage 2**: C1 (WaitEvent/WaitEventTimeout) + C2 (mgp). Real wakeup
  reduction on its own; no compositor risk. **DONE 2026-07-13 (todos/0161).**
- **Baseline (before Stage 3)**: capture the idle CPU%/wake numbers NOW —
  Stages 1–2 already moved the "before", so measuring only at Stage 4 loses
  per-stage attribution. Record: static VT2 desktop, then 3–4 settled
  windows; committed dev log. Re-measure after Stage 3 and after Stage 4.
- **audioPump gate (pulled forward, standalone commit)**: gate the 20 ms
  `setInterval` on a live-stream count. ~10 LOC, fully independent of the
  parking protocol, and it is the largest *permanent* wake floor on the
  kernel worker — no reason to make it wait for Stage 4.
- **Stage 3**: W (wm.c conversion + socket→ring notify) + D (bar gate).
  Land as THREE commits inside the item: (1) the kernel WMP-socket→
  input-ring wake, independently testable and useful beyond wm (the same
  plumbing eventually lets user32's GetMessage stop chunking at 25 ms);
  (2) the wm.c event-driven conversion; (3) `bar_present()`. A Stage-3
  problem then bisects to one commit, not one branch. Flake gate; the full
  wm e2e surface is the gate here.
- **Stage 4**: A + B (park + Dekker + doorbell-on-present + handler wires) +
  E (os-compositor.mjs resurrected with wake counters) + the after
  measurements. Flake gate.

Each stage is a coherent commit with its own green gate; the risky piece (W)
lands before the piece that depends on it (parking), so a Stage-3 revert
doesn't take the architecture down.

## Follow-on: the unified wait (todos/0178, post-Stage-4)

Decided 2026-07-14 (Stage-3 design review): wake *production* is fully
kernel-owned, but wait *multiplexing* is not — wm.c sleeps on two sources
via a bespoke kick + pre-park select (benign residual race), and user32's
GetMessage still chunks at 25ms because a process→process socket write has
no pcb to kick (shared OFDs; only a blocked reader is known). The
principled fix is ONE deferred WAIT RPC over {fds…} ⊕ input-ring ⊕
timeout ⊕ SIGPEND — readiness-check and park atomic kernel-side, signal
delivery just another wake source. Deliberately sequenced AFTER Stage 4:
0169's ARMED/PARKED protocol and wake table are written against the
existing channels and survived their adversarial review as-is; the Stage-4
wake counters then become the proof surface that the consolidation
regresses nothing. Scope, plan, acceptance: todos/0178.

**LANDED 2026-07-14** (todos/0178): kernel `FS_WAIT` (0x0420, FS_SELECT's
readiness + waiter plumbing + a ring-wake hook in `_wmPushEvent`/`_wmKick`;
signals ride the ordinary interruptible-RPC EINTR), host.js `__wait`
import in the surface backend (keeps pumpWait's frame-idle release and the
b136b72 no-park-on-entry-drain rule; `__sdl_pump_wait` stays the raw
single-source futex tier per KERNEL.md's two-tier wait rule). wm.c parks
in WAIT{sock ⊕ ring} — the pre-park select and its residual-race comment
are gone, and `peer.send()` skips the ring kick for fd-parked clients
(one wake per event). user32's GetMessage parks in WAIT{agent socket ⊕
ring ⊕ next-eligible-timer-deadline} — the 25ms chunk is dead; the
deadline honours GetMessage's hwnd/range filters (a due-but-filtered
timer must not spin the park). term converted opportunistically
(frame-loop 60Hz master-poll → own main loop on WAIT{master ⊕ ring};
its SIGCHLD rides a handler FLAG checked in pure wasm before the park —
a signal claimed at an import return inside the frame pass clears
SIGPEND, so the park would otherwise sleep past the zombie; signals
dispatch only at import returns, making flag-then-park gap-free).
Vsync stays a raw futex (the recorded escape hatch stays recorded —
neither trigger fired). Test: `tests/kernel/test_wait_e2e.js`; the
term story: `logs/2026-07-14/unified-wait.md`.

## References (verified 2026-07-12)

- host.js: `shmPresent` 5940-5960 (SAB-only; `ackConfigure` exception 5958);
  Dawn shm twin ~6177-6191; browser flavor returns at ~6135 WITHOUT the
  vsync shim (`out = Object.assign({}, inner)` at 6129); the shim itself
  ~6156-6160 (headless flavor only — dead today); `pumpWait` ~6030
  (`Atomics.wait` on the input ring, timeout form in use); `__sdl_push_*`
  ring→wasm-queue drain ~5963-6018.
- kernel.js: `vsyncTick()` ~3119 (per-pcb add+notify; notifies nobody
  today); `KernelClient.vsyncWait` ~858-875 (futex compare-and-wait, NO
  timeout — a parked waiter with no future tick waits forever);
  `_wmVersion` — **20** increment sites; `wmFocus` no-bump raise 3746-3751;
  `_wmFrame` 3277-3286 (gpu present, no wake today); `wmScene` anim prune
  ~4173; kernel page tail words + payload cap 75-76, `KP_VSYNC_EN` stamp
  1759.
- os/kernel-worker.js: full onmessage inventory 84-112 (`boot-retry`,
  `input`, `resize`, `eof`, `wm-canvas`, `screen-resize`, `wm-input`,
  `drop-file`); `setInterval(audioPump, 20)` ~379.
- os/wm.c: `__setAnimationFrameFunc(frame_cb)` 3767; `frame_cb` per-frame
  work ~3580-3720 (socket drain, tick counters, `draw_bar` every frame;
  menu/ctx/run redraw ungated; only `draw_desk` dirty-gated).
- os/win32/user32.c ~2243-2266: GetMessage = `__sdl_pump_wait(25)` chunked
  poll (the socket-wake precedent).
- Reverted 0160 attempt: impl `659902d`, revert `2d8433a` (direction, not
  correctness; 11/11 on its own test). Recoverable: the signature/skip
  mechanism, `bar_present()`, `tests/browser/os-compositor.mjs`.
- Related but SEPARATE: gpu-transport Aero-Peek thumbnails are black in the
  browser (`wmThumbnail` reads the CPU shm buffer) — a transport caveat, not
  an idle-power issue.

## When approved

Queue via `node todos/queue.js` only (never hand-edit queue.json), `check`
before committing:
- Stage 0 items at `--priority 0` (bugs-first policy).
- New items: `vsync-shim-browser` (Stage 1), `wm-event-driven` (W),
  `compositor-on-demand-raf` (A+B+E).
- Rework todos/0160 (folds into A + D) and todos/0161 (piece C) per this
  doc; decide survive-vs-absorb at queue time.
