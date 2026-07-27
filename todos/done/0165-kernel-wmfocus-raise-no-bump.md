# 0165 — kernel: wmFocus z-raise without a _wmVersion bump (stale-scene hole)

- **Status**: done
- **Design**: `todos/IDLE-POWER.md` (found by its adversarial review,
  2026-07-12) — but a standalone pre-existing kernel bug, P0 on its own.

## Goal

`Kernel.prototype.wmFocus` (kernel.js ~3737): the z-raise branch is
unconditional but the `_wmVersion++` is gated on a focus *change* — so
FOCUS/RESTORE on an already-focused-but-not-topmost window reorders
`_zOrder` with no version bump, no input event, no present. Repro entirely
from VT1 (no `wm-input`): `wmctl lower <focused-sid>` (bumps — `wmRestack`
deliberately doesn't move focus) then `wmctl focus <same-sid>` — the model
raises it, the scene version says nothing changed.

Today the cost is one-poll-frame staleness (the 60 Hz compositor repaints
anyway) and any version-delta consumer being lied to; under IDLE-POWER's
parked compositor it's a frozen screen whose pixels disagree with the
kernel hit test. Fix regardless of whether IDLE-POWER lands.

## Plan

- Test first (`tests/kernel/test_wm.js`, fake-worker deterministic suite):
  two surfaces; focus the lower one twice around a `wmRestack` lower;
  assert the second `wmFocus` both reorders `wmScene().surfaces` and bumps
  the scene version. Commit the failing leg, then the fix.
- Fix: bump `_wmVersion` when the reorder branch actually splices (keep the
  no-op path bump-free — already-topmost focus of the focused window must
  stay version-quiet).

## Acceptance

- New test_wm.js leg fails pre-fix, passes post-fix.
- `node tests/run.js --diff` green (kernel suite; no behavior change for
  any existing leg — the bump only fires when z actually changed).
