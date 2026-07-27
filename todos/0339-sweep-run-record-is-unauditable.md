# 0339 — a split sweep leaves a record that cannot distinguish a full run from a half run

- **Status**: open
- **Reported by**: the router CHECK lane (cont-104), filed by @master cont-106
- **Evidence**: first-hand, from the v177 + clang-always deploy gate (c-compiler
  `428c98bb`) — a sweep that really did run all 40 files

## Goal

Make the on-disk record of a browser sweep say **what was actually run**, so that
"the sweep passed" is an auditable claim rather than an assertion that has to be
taken from whoever ran it.

## What is established

The full browser sweep exceeds a single tool call, so this fleet's standing
practice — written into every master handoff — is to split it into two halves by
`--filter`. **Every sweep this fleet runs is therefore split, and every split
sweep destroys its own record.** Measured on the deploy gate above, where both
halves passed (20 files / 575.5 s, then 20 files / 369.0 s):

1. **`build/test-run/summary.json` has no `filter` field.** After a complete
   40-file run it reads:

   ```json
   { "results": [ { "suite": "sweep", "status": "pass", "ms": 369126, "exit": 0 } ] }
   ```

   Nothing in that record distinguishes it from a run of a single test. The
   `ms` value is *half 2's* elapsed time, which understates the real cost by
   ~61 % and is the only quantity a reader could use as a sanity check.

2. **`build/test-browser/summary.json` is clobbered by the second half.** After
   40 files it holds `results: 20` and `startedAt` = the start of half 2. Half
   1's twenty results are gone from disk. There is no merge and no append.

3. **Per-test logs accumulate, so counting them OVERSTATES.** `build/test-browser/`
   held 84 `*.log` files after a 40-file run — stale logs from earlier runs plus
   `.rep1`/`.rep2` repeat variants. Counting log filenames is not a usable
   substitute for a run manifest; it fails in the optimistic direction, which is
   the worse direction.

**The failure mode this creates.** A lane that runs only half the sweep — by
mistake, by an interrupted turn, or because it copied one `--filter` line out of
a handoff — produces a record byte-indistinguishable from a lane that ran all of
it. Both say `sweep: pass`. Reviewing the artifact cannot catch it; only watching
the console output live can, and console output does not outlive the turn. This
is the same class as `todos/0334` and the (AZ) measurement lessons: **a green
signal whose scope is unrecorded is not evidence of scope.**

## Plan

- Record the actual selection in `build/test-run/summary.json`: the `--filter`
  string as given (`null` when absent) and the **count of test files actually
  executed**. A reader must be able to see `filter: null, files: 40` and know it
  was a full run.
- Stop the second half clobbering the first. Either key the browser summary by
  filter (`summary-<hash>.json`) and have `run.js` merge, or make
  `build/test-browser/summary.json` **append** its results and carry a list of
  the runs that contributed (each with its filter, start time and file count).
  Merging is preferable — one file that answers "what has been run against this
  tree" is what a reviewer actually wants.
- Emit a **warning when a sweep runs with a `--filter`**, naming how many of the
  suite's files were selected out of the total (`sweep: 20 of 40 files selected`).
  Splitting is legitimate and will continue; it should just never be silent.
- Consider clearing stale `build/test-browser/*.log` at suite start, so the log
  directory reflects one run. If they are deliberately kept, the run manifest
  above is what makes them interpretable, so the manifest is the load-bearing
  half of this ticket.

## Acceptance

- A split sweep (two `--filter` halves) leaves a record from which a reader can
  determine that all 40 files ran, without access to the console output.
- A single-half sweep leaves a record that is **visibly** a partial run.
- The `todos` suite stays green and no existing consumer of
  `build/test-run/summary.json` breaks.

## Notes

Filing was deliberately delayed by @master cont-105: two design lanes were
allocating ticket ids concurrently and `0337` was already double-allocated, so a
third concurrent allocation was the live hazard. That contest is resolved
(`clang-always` kept `0337`, the dispatcher renumbered to `0338`) and this id was
re-derived against a freshly fetched `origin/main`. **A gap that does not enter
`todos/` does not exist** — which is precisely why this one had to be written
down rather than carried in a handoff.
