# IDLE-POWER Stage 4 close-out: gates, the lost-notify regression, numbers

todos/0169 (on-demand compositor) landed this morning as four commits
(c0481d1 kernel ARMED/PARKED protocol, 2eeaf21 host doorbell-on-present +
frame-idle, 06a6cba compositor dirty-gated submit + parked rAF, 0625cc0
os-compositor.mjs + flake tripwire) — and the session hit its rate limit
seconds after the last commit, before any close-out gate ran. This log is
the close-out: the gates, the P0 regression they caught, and the after
numbers.

## The lost-notify regression (fixed: e23d1f7)

The first full gate run failed `test_wm_service_e2e.js` — the placement
legs: winbox (and under load even the wm's own taskbar) listed at the
KERNEL CASCADE position at `==list1`, i.e. the wm hadn't processed
EV_CREATED yet. Solo it failed 2/2 on HEAD and 0/1 on origin/main; a
per-commit bisect in a worktree pinned **2eeaf21**, and deleting just the
pumpWait-entry frame-idle post confirmed the trigger.

Root cause was NOT the post itself — it was the 0168 socket→ring kick
being a **bare `Atomics.notify(IR_WPOS)`**. A notify on an unchanged word
wakes nobody: one landing between a parker's last ring check and its
`Atomics.wait` entry is simply lost, and the parker sleeps its full chunk
(wm.c: 1s) past the WMP event. wm.c's pre-park `select()` documented this
as a residual gap "costing at most one 1s chunk"; 0169's frame-idle post
sits exactly inside that window (pumpWait entry, before the park) and
widened it from negligible to reliably-lost at wm startup — the wm always
presents (taskbar) before its first park, so it always posts, and hush
spawns winbox at exactly that moment.

The fix closes the window instead of shrinking it: `_wmKick` pushes an
**all-zero type-0 ring record** so WPOS — the futex word — changes. The
parker either drains a non-empty ring at entry or its wait resolves; a
lost wake is impossible by construction. host.js needed zero change:
drainInput already counts-and-skips unknown types, and return-on-drained
re-polls (the 0168 contract). Full ring needs no record (WPOS≠RPOS
already denies any park). wm.c's pre-park select survives as a redundant
belt until 0178 retires the loop wholesale.

Test: `test_sockwake_e2e.js` grew the phase-2 interleave — the kick fires
while the app is deliberately OUT of the park (annotated usleep), then
the park must return at once. Verified failing pre-fix (naps the full
4000ms), passing post-fix. Two lessons re-learned:

- **A pure notify is not a wake protocol.** If the waiter's futex word
  doesn't change, there is always a lost-wake window; "the caller
  re-polls" only covers wakes that happen, not wakes that don't.
- **The width of a race window is a budget someone else will spend.**
  2eeaf21 added ~a postMessage inside a window that was "too small to
  hit" — and the estate's most timing-sensitive e2e started failing 2/2.

Also caught by the close-out, fixed in 22d7c12:

- `test_comp_park_e2e.js` was committed but never registered in the
  table-driven kernel suite — it ran only when invoked directly, and the
  flake tripwire's `comp_park_e2e` filter term matched nothing.
- `test_os_boot.js` (deliberately `--no-fixture`: the bake path is under
  test, so it does 3+ full ~100s bakes) sits right at the 600s default
  under -j4 suite load — 333s solo, 600.0s TIMED OUT in the full run.
  Per-file `timeoutMs: 900000` in the suite table.
- One unreproduced flake noted: os_boot's `--fresh-system keeps user
  files` failed once solo on HEAD (empty stdout from the session), passed
  on immediate rerun and on origin/main, and a manual boot.js repro
  passes. Not 0169-shaped (headless, no rings/surfaces involved). Watch.

## Gates (all green, post-fix)

- full kernel suite: 65 files, 0 failed (wm_service and os_boot both
  pass; comp_park registered after this run and green via the suite)
- flake gate (`node tests/flake.js`, 3× under load ×10): kernel leg
  term/wm_service/os_apps stable 3/3, browser leg
  os-compositor/os-doom/os-term stable 3/3
- full browser sweep: 25/25
- `test_sockwake_e2e.js` both interleaves, `test_comp_park_e2e.js`,
  `test_vsync.js` (22 protocol legs) individually green

## idlemeter after Stage 4 (2026-07-14, main @ 22d7c12, image v90, 20s)

| scenario | total | browser | gpu | renderer | utility |
|---|---|---|---|---|---|
| A. idle desktop | **8.8%** | 6.0% | **0.2%** | 2.1% | 0.4% |
| B. 4 settled windows | 449.9% | 3.9% | 441.2% | 4.4% | 0.3% |

Baseline (pre-Stage-3, main @ e824fab) was A: 350.0% total / 340.6% gpu,
B: 456.9% / 444.8%. (100% = one core; gpu = headless SwiftShader, a CPU
rasterizer, so absolute numbers are amplified vs real hardware.)

Reading:

- **Scenario A is the Stage-4 acceptance, delivered: 350% → 8.8% total —
  the parked compositor submits nothing on a settled desktop.** The gpu
  bucket went 340.6% → 0.2% (~1700×); the residual total is mostly the
  browser process's own idle floor.
- **Scenario B did not move, and per the protocol it can't yet**: winbox
  is a `__setAnimationFrameFunc` frame-loop app, so it vsync-arms every
  tick — KP_VSYNC_ARMED > 0 pins the compositor awake (parking would
  strand the waiter: no ticks, no resolve, a frozen app, not just a stale
  screen). One animating app = the pre-0169 bill for the whole screen.
  That's the correct conservative behavior; the remaining work is app-
  class conversion (present-on-change instead of per-tick redraws for
  static scenes), not compositor policy. The wm (0168) and mgp (0161)
  conversions are the template.

Refs: todos/0169 (now done), todos/IDLE-POWER.md, todos/0178 (unified
wait — owns retiring wm.c's pre-park select and GetMessage chunking),
logs/2026-07-14/idle-power-stage3.md, logs/2026-07-14/idle-power-baseline.md.
