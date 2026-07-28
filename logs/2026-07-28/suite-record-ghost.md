# 0368 — the `recorded == total` ghost, the carried-FAIL contract, and Status drift both ways

Branch `suite-runner-invariant`, spawned by the 24h review (§4.5 + nomination
3): `recorded == total` is the estate's definition of "the whole suite ran",
but the coded invariant was weaker than the documented one, and `queue.js
check`'s Status validation pinned only the two drift classes 0353 had actually
observed. Same family: a gate whose pass condition can be satisfied by
something that no longer corresponds to reality.

## The ghost (tests/lib/suite-runner.js)

The 0339 merge carried forward every previous result whose file was not in
`selectedSet` — membership in the **current** entry table was never consulted.
So a deleted/renamed file's stale record survived the merge and counted toward
`recorded`: rename `t4`→`t5`, run filtered around `t5`, and the artifact
certified `recorded == total` while `t5` had never been measured. The pre-fix
closing line in the red control even printed **`5/4 recorded`** — the
overcount was visible if you looked, but nothing failed on it.

Decisions worth keeping:

- **The contract is now stated in code, not folklore.** The canonical
  statement of what `recorded == total` certifies (every CURRENT file has a
  record — measured now or carried-tagged from a named prior run) and what it
  deliberately does NOT certify (freshness → read `runs`; greenness → read
  `carriedFailed`) lives at the merge block in suite-runner.js, mirrored in
  the ticket. Consumers that need "measured now" must require
  `executed + resumed == total`.
- **Ghost drops are loud and counted** (`files.staleDropped` + a ⚠ line
  naming the files) — the no-silent-caps rule. A reader of a suddenly-partial
  record needs to know *why* it went partial; and a pre-0339 summary lying
  around can legitimately reference files long gone, which is exactly the
  input the filter now handles.
- **Red control committed first, failing** (f9f18af5, 5 of 20 checks red on
  the pre-fix engine) — the letter of test-first this time, after the review
  called out 0354/0356 for bending it.

## The carried-FAIL contract (written, previously by-design-but-unwritten)

A carried FAIL does not fail the current run's exit — the run that measured it
already exited red, and this run was explicitly asked not to re-measure that
file. The alternative (failing the exit) would push a lane that just fixed
file A under `--filter=A` to delete `summary.json` for a green exit,
destroying the whole-suite record the merge exists to keep. The red stays
visible instead: status + `carried` tags on the record, `files.carriedFailed`
in manifest/return, the count on the closing line, and a red `[N carried
FAIL]` column in `tests/run.js`'s per-suite summary. Whole-suite green is a
property of the **record**, never of one invocation's exit code. Both halves
pinned in `tests/host/test_suite_record.js` §8.

## Status drift, generalized (todos/queue.js)

0353's checks were an allowlist of the two observed instances. Generalized to
leading-token **direction classes**: done/ must not lead OPEN-like
(`open|ready|wip|unstarted|blocked|awaiting|in progress|in review` —
auto-fixable, directory wins) nor with `deferred` (report-only); open files
must not lead DONE-like (report-only: close it or say what remains). A full
status state machine was **rejected**: the Status line is prose by design, the
directory is the source of truth, and the checker's contract is only "the
prose must not contradict the directory" — contradiction is decidable by
leading token, anything further is prose-guessing. Neutral-prose lines pass
unvalidated; that residual is accepted, recorded in 0368, and pinned by test.

The generalized check had live catches at head, both directions:

- `done/0228` said "in progress (branch …)" (auto-fixed), `done/0149`/`0150`
  still said "deferred" despite shipping as the keybind epic (v124),
  `done/0140`/`0270`/`0275` carried neutral-but-stale narratives (hand-fixed,
  each now citing its closing evidence).
- **`0313` sat OPEN in the queue at heavy difficulty with Status "DONE —
  verdict YES-BUT"** — a lane picking it from the queue would burn a turn
  discovering it finished on 2026-07-27. Closed via `queue.js done 0313`
  (acceptance fully met: report delivered, compiler defects filed, 0117 R2
  un-parked, M1 executed by 0340/0331).

## Test debt owed to the master

`tests/run.js --diff origin/main` maps this branch's diff to **all six**
suites (tests/lib/* is load-bearing everywhere). Run here: todos (5/5), host
(all green, incl. the new 20-check suite-record contract), blockfs (15/15 —
suite-runner-backed, exercises the new merge path for real), unit (786 green;
one first-run red on `stdlib/usleep_zero` was the **already-filed 0361**
wall-clock-under-load flake, green on re-run). **kernel and sweep are owed at
merge** — forbidden in this lane by the thread constraints (heavy lock; the
master coordinator is active in the main tree).
