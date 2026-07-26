# 0304 — test_os_boot.js tail leg: a fixed 300s spawnSync timeout around a full in-boot bake reports contention as a product failure

- **Status**: open
- **Design**: this file. Source: caught live during the cont-78 install-gate lane
  (`tests/browser` + kernel suites running concurrently in two worktrees, 2026-07-27).

## The symptom

`tests/kernel/test_os_boot.js`'s tail leg wraps a **full in-boot bake** in a `spawnSync` with a
**fixed 300s timeout**. Under CPU contention — another worktree running its own heavy suite, which
is now normal given the worktree-parallel convention — that timeout fires and the leg surfaces as:

```
FAIL post-bypass boot exits clean  null
```

**`null` is the `status` of a process that was KILLED at its timeout budget.** Nothing in that
output says "timed out": it reads exactly like the boot exited uncleanly, i.e. like a product
failure. The lane that hit it had to reason from first principles to work out that its own
concurrency, not the code under test, produced it.

## Why this matters more than a flaky test normally would

This is the same class as `0171`/`0154`: **a test whose failure text does not distinguish "the
thing under test is broken" from "the harness never got to run it."** It is worse than a plain
flake because it is *actively misleading* — a red run here points the reader at the boot path.

It also biases the whole gate toward false alarm exactly when the machine is busiest, which is
precisely when a coordinator is most likely to be running two lanes and least able to afford
re-running an 800s kernel file to decide whether a failure was real.

## What to do

1. **Make the timeout legible.** When `spawnSync` returns `status === null` (and/or
   `error.code === 'ETIMEDOUT'`), the check text must say so — e.g.
   `the boot was KILLED at its 300s budget (contention?), not an unclean exit`. This alone
   converts a misdiagnosis into a correct one and is the minimum bar.
2. **Then decide whether the budget itself is wrong.** 300s around a full in-boot bake is tight on
   a quiet machine and clearly insufficient on a contended one — `test_os_boot.js` as a whole needs
   ~800s on this box (main's own last full run records **652s**). Either scale the budget, or make
   the leg acquire the heavy lock so it is not racing (see `0303` — a bare boot currently takes no
   lock at all, which is the root of the contention this leg is exposed to).
3. **Do not "fix" it by widening the timeout alone** — a longer fixed budget still reports `null`
   on the day it is exceeded. Item 1 is the load-bearing part; item 2 is the tuning.

## Acceptance

- A killed-at-budget tail leg prints a message that names the timeout, not a bare `null`.
- Verified RED-then-GREEN: induce the timeout (a short budget, or real contention) and show the
  new message; then show the normal path still passes.
- `0303`'s outcome is checked against this item — if `os/boot.js` starts taking the heavy lock,
  say explicitly whether that removes the contention source here or merely narrows it.

## Note on scope

This is a **test-harness diagnostic** item, not a product bug — but it is filed rather than noted
because a gap that does not enter `todos/` does not exist, and this one was surfaced by a lane as
"out of scope, not fixed" and would otherwise have lived only in a coordinator report.
