# 0368 — `recorded == total` can be satisfied by a ghost record; the carry filter must intersect the CURRENT file set

- **Status**: open — fix + red control on branch `suite-runner-invariant`;
  master reviews/merges (suite-runner.js gates every artifact-backed suite).
- **Design**: — (the contract is small enough to live in this ticket and in
  `tests/lib/suite-runner.js`'s contract comment, which is the canonical copy)

## Goal

`files.recorded == files.total` in a suite's `summary.json` is the estate's
definition of "the whole suite was covered" (todos/0339) — it is what
`tests/run.js` renders as non-PARTIAL and what a reviewer reads as full-scope
evidence. The coded invariant is weaker than the documented one, and the gap is
exactly the class the 0339/0353/0358 cluster exists to eliminate: a gate whose
pass condition can be satisfied by a record that no longer corresponds to
anything real.

## The contract (what `recorded == total` certifies)

> **Every file in the suite's CURRENT entry table has at least one result
> record in this summary** — measured either by this run (fresh, or this run's
> own `--resume` chain) or by a prior merged run (tagged `carried`, stamped
> `carriedFrom`).
>
> It does NOT certify **freshness** (a carried record may be arbitrarily old —
> the `runs` list says when each contributor ran; a consumer that needs
> "measured now" must require `executed + resumed == total`) and it does NOT
> certify **greenness** (`recorded` counts records, not passes — statuses live
> on the records; see the carried-FAIL contract below).
>
> Two rules keep the certificate honest: (a) a record counts **only if its
> file is in the current entry table** — stale records for deleted/renamed
> files are dropped at merge, loudly; (b) a file this run SELECTED is never
> carried — its fresh result replaces the old one, and if fail-fast stopped
> first, the record simply lacks it.

Until this ticket, rule (a) did not exist in code: the carry filter
(tests/lib/suite-runner.js) kept every previous result whose file was not in
`selectedSet` — membership in the CURRENT suite was never consulted. So after
a rename D→E, a run filtered around E carried D's stale record and still
reported `recorded == total` while E had never been measured: a full-coverage
certificate satisfied by a ghost. It takes an offsetting rename against a
stale summary to trigger, so it is unlikely — but "unlikely" is not what a
load-bearing gate's definition should rest on, and renames of test files are
routine.

## The carried-FAIL contract (existing semantics, now written down)

A run's **exit code** and `passed`/`failed` counts cover ONLY what this run
measured (executed files + its own resume chain). A carried FAIL does not fail
this exit: the run that measured it already exited red, and this run was
explicitly asked not to re-measure that file (it was filtered out). Failing
here would push a lane that just fixed file A under `--filter=A` to delete
`summary.json` to get its green exit — destroying the whole-suite record the
merge exists to keep. The red must stay VISIBLE instead of becoming an exit
code: the record keeps `status: 'fail'` + `carried` tags, `files.carriedFailed`
counts them, and the closing line names the count. A consumer that wants
"whole suite green" must read the RECORD (every result green AND
`recorded == total`), never a single invocation's exit code.

## Plan

1. **Red control first, committed failing** (the 0339 test file is the right
   home): rename a recorded file out of the suite, run filtered around its
   replacement — the old code reports `recorded == total` with the ghost
   counted; the assertion demands `recorded < total` and no record for the
   ghost. Plus a carried-FAIL leg pinning exit semantics + `carriedFailed`.
2. **Fix**: carry filter = `currentSet.has(file) && !selectedSet.has(file)`;
   dropped ghosts reported loudly (never silently — the no-silent-caps rule)
   and counted as `files.staleDropped`; contract comment blocks in
   suite-runner.js as the canonical statement; `carriedFailed` surfaced in the
   files block, the closing line, and the return value; `tests/run.js`'s
   coverage formatter shows carried FAILs.
3. **Same family, folded in (review §4.5)**: `queue.js check`'s Status
   validation pins only the two OBSERVED drift classes (done/-says-"open";
   open-says-round-remaining-that-body-records-DONE). Generalize to
   direction blocklists — done/ must not lead with an OPEN-like token
   (`open|ready|wip|unstarted|in progress|in review|awaiting|blocked`,
   auto-fixable → "done") nor with `deferred` (report-only: done/dropped/
   superseded is a judgement); open files must not lead with a DONE-like token
   (`done|shipped|landed|merged|fixed|closed|...` — report-only: close the
   ticket or say what remains). A full status STATE MACHINE is deliberately
   rejected: the Status line is prose by design (the author's text is
   preserved by every fixer), the DIRECTORY is the source of truth, and the
   checker's contract is only "the prose must not contradict the directory" —
   contradiction is decidable by leading-token class, anything further is
   prose-guessing (the 0353 scope note: a checker that guesses is worse than
   no checker). Lines that assert neither state pass unvalidated; that
   residual is accepted and recorded here, not a scheduled gap.
   Live drift found by the survey and fixed with the checker in one commit:
   6 done/ tickets (0140/0149/0150/0228/0270/0275) with stale
   in-progress/deferred/awaiting narratives, and 0313 — an OPEN ticket whose
   own Status line says "DONE — verdict YES-BUT" with every acceptance
   criterion met (report delivered, follow-ups 0340/0331 filed, 0117 R2
   un-parked) — closed via `queue.js done 0313`.

## Acceptance

- The ghost test fails on the pre-fix engine (committed red, fixed in the
  following commit) and passes at head.
- `recorded == total` implies every CURRENT file has a record; a
  deleted/renamed file's stale record can no longer count toward `recorded`,
  and its drop is loud + counted (`files.staleDropped`).
- The carried-FAIL semantics are written (suite-runner.js + this ticket),
  pinned by test, and visible in output (`files.carriedFailed`, closing line).
- `queue.js check` rejects both new drift directions with tests; the tree is
  clean under the stricter check (live drift fixed in the same commit).
- No behavior change for: unfiltered runs, `--resume`, `--repeat`, fail-fast,
  pre-0339 summaries (they may reference files long gone — precisely the
  input the ghost filter now handles).
