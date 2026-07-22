# 0283 — test_wm_service_e2e ~33% flake under load (taskbar borderless-at-bottom probe)

- **Status**: open
- **Design**: this file. Found 2026-07-22 during the 0280/0281 bughunt gates.

## Goal
`test_wm_service_e2e` flakes ~33% **under load** (the flake tripwire's kernel
leg) on a probe that asserts "taskbar is borderless, parked at the bottom edge
(0,740 @1024x768)". It is a **pre-existing timing issue on `main`, NOT a
regression** from any bughunt lane — 0280's executor reproduced it IDENTICALLY
on clean `origin/main` @9de9fbb (before 0279/0280/0282/0281 landed). Flagged for
its own item rather than touched from a bundle lane (never edit wm.c from a lane
that isn't scoped to it).

## Plan
- Repro under load first: run the flake tripwire kernel leg 3×+ under `-j`
  parallelism (single isolated runs pass — it's load/timing-sensitive).
- Root-cause the race: the probe reads taskbar geometry/borderless state before
  the wm has finished placing/reparenting the taskbar surface at boot. Likely a
  missing wait/settle in the TEST (poll for the taskbar to reach its final
  bottom-edge geometry) rather than a product bug — but confirm which. If the
  wm genuinely reports transient wrong geometry during startup, that's a product
  timing bug worth fixing at the source.
- 0281 touched `test_wm_service_e2e.js:874` (a FLAGS-column width match, 7→8 for
  the new `U`/WMP_F_TRANSIENT char) — unrelated to the flake; 0281's run happened
  to see wm_service 3/3, but that is load-dependent luck, not a fix.

## Acceptance
- The flake tripwire kernel leg passes 3/3 under load with no geometry-probe
  flake; the fix (test settle-wait or product startup-geometry fix) is
  identified and pinned. Triage note in the dev log which of the two it was.

## RESOLUTION (2026-07-22) — verdict (A) test artifact; test-only fix, no image/deploy
Root cause: `list1` was snapshotted after only `wmctl wait win winbox`, which proves
the winbox SURFACE exists (kernel-side) but NOT that the wm has drained its startup
event backlog and PLACED it. Under load the wm could still be mid-startup → probe
caught the taskbar at its raw create position (e.g. `1024x36+56+86`, create-focus
still on it) + winbox unplaced at the kernel cascade (`240x160+8+38`, unfocused) =
the ~33% flake. Reproduced 2/12 (17%) under 12 concurrent boots.

Fix (test-only): settle-wait `WSID=...; wmctl wait flag $WSID f` before `==list1`.
winbox's `f` is set by kernel create-focus at MAP time (wm's first WMP_MOVE via
place(), todos/0069); the taskbar's EV_CREATED drains BEFORE winbox's on the wm's
in-order socket + FIFO wm→kernel processing, so winbox-focused ⟹ taskbar MOVE(0,732)
already landed. Waiting on it settles BOTH placements. Product converges correctly →
NO product change, NO image bump, NO deploy.

Pinned: 28/28 clean across two heavy rounds (pre-fix 17% flake, fluke ~0.5%); flake
tripwire kernel leg 3/3; full kernel suite green except the 2 known unrelated
load-flakes (test_clang_pkgs_e2e -j4 dist race, test_tty_e2e load-timeout — both
green isolated, neither touched by this kernel-test change). Browser sweep: branch
has ZERO product-code delta from main (only this one kernel test file differs), and
the sweep never loads kernel test files → identical-by-construction to main's
shipped-green v143 sweep (28/34 files green at checkpoint before the orphaned turn).

Shipped: branch `wm-service-flake-0283` @ c5461b1 → merged to main `ff1a914`, pushed.
image.json unchanged at 143. NOTE: the executor's turn was orphaned twice (backend
restart, then the 600s browser-sweep foreground ceiling auto-backgrounding past
turn-end); master finished the commit/push/merge close-out directly after verifying
the diff and gate.
