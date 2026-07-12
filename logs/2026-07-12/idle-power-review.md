# IDLE-POWER: adversarial design review + revision

The idle-power proposal (`todos/IDLE-POWER.md`, unifying 0160/0161 + an
on-demand compositor) went through an adversarial code-verification review
before queueing: four independent verification passes (linchpin fact, wake
coverage, park/unpark races, revert archaeology/scope) over
host.js/kernel.js/compositor.js/wm.c, plus git archaeology of the reverted
0160 attempt (`659902d`/`2d8433a`). Verdict: architecture right, first-draft
spec wrong in four load-bearing ways. The doc was revised in place; this log
records the *why* behind the biggest deltas.

## The dead-shim discovery (the review's biggest find)

**todos/0100's vsyncWait pacing was never wired into host.js's browser SDL
flavor.** The `hooks.vsyncWait().then(cb)` requestAnimationFrame shim
(host.js ~6156) exists only in the headless/shm flavor's return object; the
browser flavor returns earlier (~6135) inheriting `createBrowserSDL`'s
deadline-setTimeout latch — and headless kernels never advertise vsync, so
the shim is dead code everywhere. No process parks on `KP_VSYNC_SEQ`;
`vsyncTick()` notifies nobody; "hidden tab parks SDL apps" is design intent,
not shipped behavior. CLAUDE.md + KERNEL.md got caveat notes; wiring the
shim is now Stage 1 of the design (0167).

## Doorbell-on-present, not doorbell-on-arm

The draft's wake-on-rAF-arm doorbell provably deadlocks: `Atomics.waitAsync`
registration is passive, so a never-idle app that lands in `vsyncWait` just
as the compositor parks waits forever — a frozen *app* (no input drain, no
cooperative signals), not merely a stale screen. And rAF-less presenters
(user32's chunked-`pumpWait` GetMessage loop — winmine's WM_TIMER counter,
notepad's caret; term on pty output) never arm at all. The revised protocol:
per-pcb `KP_VSYNC_ARMED`/`KP_COMP_PARKED` tail words, shim increments ARMED
before waitAsync, `shmPresent` rings when PARKED, park is a Dekker
store-PARKED-then-recheck. GRACE demoted to an optimization (correct at 0).
gpu presents already ride the `wm-frame` postMessage — `_wmFrame` just gains
a `scheduleFrame()`.

## wm.c is a required adopter (the scope correction)

/bin/wm is the only always-running SDL app on an idle desktop and is a
frame-callback app — with only the taskbar present-*gate* it still wants
frames every tick, so nothing ever parks; and once parking works, a
frame-paced wm means the screensaver never raises on an idle system (its
1 Hz GET_IDLE poll rides frame_cb — idle is exactly when it must fire).
Conversion to `SDL_WaitEventTimeout(1000)` needs kernel WMP-socket→input-
ring notify plumbing (`pumpWait` parks on the ring only; wm's events arrive
on the socket — the same reason user32's GetMessage chunks at 25 ms).
Estimate revised ~350–500 → ~550–850 LOC; land plan changed from one branch
to five stages (each with its own green gate, wm.c before parking so a
Stage-3 revert doesn't take the architecture down).

## Wake-coverage holes found (all now in the doc's table)

- `wmFocus` raises without bumping `_wmVersion` when focus doesn't change
  (kernel.js:3746-3751) — a real pre-existing kernel bug, filed P0 (0165).
- `wm-frame` (gpu present) and `drop-file` handlers wired to
  `scheduleFrame`; the draft's "VT switch" wake row was fiction (no such
  message type; a switch doesn't change the scene).
- The draft mislabeled wm.c-rendered animations (screensaver, peek popups,
  snap preview) as "compositor's own"; the compositor's own anims are only
  the minimize/restore fly records, and `wmScene()` prunes them at read
  with no bump — park decisions come from the post-prune scene of an
  already-drawn frame.
- `_wmVersion` has 20 increment sites, not 21; audioPump's 20 ms interval
  is a permanent 50 wake/s floor unless gated on live streams (now in
  scope).

## Revert-triage resolution

The 0160 deferral note's open flake-vs-regression question is answered:
both failure sets were the `785eca2` (notepad desktop icon) hardcode class,
unrelated to the 0160 attempt. `test_recycle_e2e` was fixed by 0164;
`test_wm_service_e2e` still fails 3 legs on clean main (`DESK_ENTRIES`
omits notepad) — filed P0 (0166), must land before any re-land so the old
failures can't re-muddy a new verdict.

Queue: 0165/0166 at P0; 0167 (vsync-shim-browser, Stage 1), 0168
(wm-event-driven, Stage 3 = W+D, absorbs 0160's taskbar-gate half), 0169
(compositor-on-demand-raf, Stage 4 = A+B+E, absorbs 0160's damage-skip
half) at P1 head; 0161 survives as Stage 2 (C). NB the doc's "provisionally
0162" was stale — 0162 is the registry-SQLite idea.
