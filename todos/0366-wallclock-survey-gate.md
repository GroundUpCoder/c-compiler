# 0366 — nothing prevents a NEW wall-clock budget entering tests/unit — the 0361 survey is a hand-run audit

- **Status**: open
- **Design**: —
- **Found by**: todos/0361 (its own residual)

## Goal

todos/0361 removed every upper-bound wall-clock budget from `tests/unit/**` and
re-encoded the one property that needed one as a **requested-duration**
assertion in `tests/host/test_sleep_clamp.js`. What it did NOT do is make that
state stick.

`tests/scan-wallclock.sh` lists every `tests/unit/**` source that reads a clock
(22 today). It is deliberately over-inclusive — reading a clock is only the
*necessary* condition; the classification of each hit into "asserts an elapsed
threshold" vs "reads the clock for something else" is a **human judgement**
recorded once, in `logs/2026-07-28/0361-wallclock.md`. Nothing re-runs it, and
nothing notices when a new test lands with `elapsed_ms < 100` in it.

That is the same shape 0361 was about: a documented state that reads as
known-and-handled while the thing it documents drifts. The unit tier's whole
value is "if this is red, something is broken"; one new budget re-opens the
"probably just load" habit.

## Plan

Options, cheapest first — pick one, do not do all three:

1. **A `todos`-suite check over the scan.** Commit the classification as data
   (a small JSON: path → verdict + one-line reason), and have a test assert that
   `tests/scan-wallclock.sh`'s output matches the classified set exactly. A new
   clock-reading unit test then fails with "classify me", which is a 30-second
   job and cannot be ignored. Precedent: `todos/liabilities.js check`.
2. **Narrow the scan to the dangerous shape** — an elapsed subtraction compared
   against a literal — and make an unclassified hit a hard failure. Fewer
   prompts, more false negatives; the necessary/sufficient trade-off is the
   whole design question here.
3. Fold it into the recurring sweep `todos/0302` and accept the drift window.

Whichever: the positive control matters. A scan whose "nothing found" is
load-bearing must be shown to find a planted decoy — 0361's log records the
two-decoy control run for the current scan; keep that discipline.

## Acceptance

- A NEW `tests/unit/**` test that asserts an elapsed-time threshold makes some
  suite go red (or, for option 2, makes it go red without needing a human to
  remember `tests/scan-wallclock.sh` exists).
- The check ships with a demonstrated positive control (plant a decoy, show it
  caught, remove it).
- Register entry **L54** retired.
