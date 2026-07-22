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
