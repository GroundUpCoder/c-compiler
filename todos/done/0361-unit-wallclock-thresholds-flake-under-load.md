# 0361 — unit tests that assert a wall-clock threshold go red under lane contention

- **Status**: done
- **Priority**: P2
- **Found by**: the 0340 merge gate (master cont-120), while three lanes were
  running concurrently

## What happened

Gating the 0340 merge with `0354`'s kernel suite running in another worktree,
the `unit` suite failed:

```
  FAIL  unit/stdlib/usleep_zero
        Stdout mismatch:
        --- expected ---   0 1
        --- got ---        0 0
784 passed, 1 failed, 1 xfailed, 3 skipped  (33.2s)
```

Re-run with nothing else changed: **785 passed, 0 failed (29.8s)**. The merge
under test touches nothing in that path (`git diff` over `compiler.js` for
`usleep`/`nanosleep`/`clock_gettime` is empty; 0340's only time-adjacent files
are `vendor/cpython/**`, which the unit suite does not compile).

## Why it is red

`tests/unit/stdlib/usleep_zero/main.c` asserts a **wall-clock budget**, not a
behaviour:

```c
for (int i = 0; i < 20; i++) r |= usleep(0);
...
printf("%d %d\n", r, ms < 100);
```

The property it means to test — *`usleep(0)` must not clamp to a millisecond
sleep* — is real and worth testing. The encoding is not: `ms < 100` is a
statement about **the machine**, and on a box running a 4 GB-per-boot kernel
suite in another worktree, 20 syscalls can exceed 100 ms without anything
being wrong. The same suite ran 33.2 s under contention vs 16.7 s solo — a 2×
slowdown that lands squarely on a fixed 100 ms budget.

## Why this matters more than one flaky test

Four concurrent lanes is the working norm here, and the master gates on the
merged tree while lanes are live. A wall-clock assertion in the **unit** suite
— the cheap, always-run, "if this is red something is broken" tier — has two
costs, and the second is the expensive one:

1. It burns a gate cycle on a re-run.
2. It teaches everyone that a red `unit` might just be load. That is the
   habit that lets a **real** regression through, and it is the same failure
   shape `todos/LIABILITIES.md` exists to prevent: a true-sounding explanation
   ("it's just the machine") that confers legitimacy and stops the looking.

## Goal

Find every unit test that asserts a wall-clock threshold and re-encode the
property without a clock budget, or move it to a tier where a budget is
meaningful.

Do **not** simply raise the constant. `ms < 100` → `ms < 1000` moves the flake
rather than removing it, and makes the test weaker at catching the clamp it
exists to catch: a real 1 ms clamp over 20 calls is only 20 ms, so a 1000 ms
budget would pass the very bug this test was written for.

## Acceptance

- A survey of `tests/unit/**` naming **every** test whose pass/fail depends on
  elapsed wall-clock time (this is a population claim — state the command and
  the count, not an impression). At least `stdlib/usleep_zero` and
  `blockfs_usleep_zero` are in it; enumerate the rest rather than assuming
  those two are all.
- Each one either re-encoded against something deterministic, or explicitly
  justified as belonging in a timing tier with a stated budget rationale.
- A **positive control**: demonstrate the re-encoded `usleep_zero` still fails
  when `usleep(0)` is made to clamp to a millisecond. A timing test rewritten
  into a test that cannot fail is worse than the flake.
- `unit` green, and green again when re-run with a heavy suite deliberately
  running alongside it.
