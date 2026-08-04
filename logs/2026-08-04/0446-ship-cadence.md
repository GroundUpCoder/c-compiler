# #446 — the ship cadence, written down

## What was wrong before this

`CLAUDE.md` line 393 carried a CROSS-REFERENCE to "ticket #446's ship cadence"
and nothing else. The operative clauses lived only in the ticket body. Measured
at `origin/main` @ `c632e5e1`: `immediate-ship`, `P0 defect` and
`since the last ship` all returned zero hits, positive-controlled against
`behaviour-changing`, which matched at 296/303/341/342 — so the nulls are real
absences, not a broken instrument.

That is the worst shape a rule can be in. A cross-reference that names a rule
written nowhere reads to a hurried shipper as "documented elsewhere", so nobody
looks again. It is the same failure mode the liability register exists to catch.

The rule is now rule **6** of "Gate cost + gate batching", extending #415's
section, #440's 3a and #428's rule 5 rather than colliding with them. The
cross-reference now points at rule 6 by position, not at a ticket number — a
rule that outlives its ticket must not be addressed by ticket number alone.

## Two clauses the ticket body does not carry, and why they are in the text

**What "behaviour-changing" counts.** The 2026-08-04 N6 decider ruling (recorded
as a comment on the ticket, not in its body) defines it for clause 3 as *changes
the behaviour of the SHIPPED ARTIFACT*. Without that line a reader naturally
borrows 3a's binary — anything not comment/doc-only — which is a category error:
3a's binary answers a *gate attribution* question, this one answers *when has
enough user-visible delta accumulated to justify a deploy*. Under the borrowed
reading the counter read ~9 when the true count was 5, i.e. it fires a ship that
delivers nothing. A rule whose counter can be read two ways is not executable
from the document alone, which is this ticket's whole acceptance test.

**Establishing the baseline.** Clause 3 counts "since the last ship", and that
baseline has been wrong twice — most recently at v231, where an inherited
handoff figure named v224 when v225 had shipped 90 minutes later
(`logs/2026-08-04/deploy-231.md`). The count is only as good as the baseline, so
the rule now says where the baseline comes from: the last line of the deploy
ledger, confirmed against the live edge — never a handoff and never the previous
deploy log.

Both are clarifications of the ruled cadence, not extensions of it. No behaviour
changed here; the cadence was already operative and had already been applied
twice.

## A stale premise in the ticket body, left as-is

The body's "measured constraint" cites `tests/run.js` RULES line 166 mapping ANY
change under `os/` to both heavy suites. **#428 has since landed and narrowed
it** — six files belonging to exactly one host now draw one heavy suite
(`CLAUDE.md` rule 1's table rows 4-5). The body's premise is stale, but its
conclusion is not: every other path under `os/` still draws both suites
deliberately, so the cadence remains the larger throughput lever. #428's own log
says the same in "Honest sizing". Not edited — a ticket body is a record of what
was argued at filing time.

## Checks

Docs-only. `node tests/run.js --diff origin/main --dry-run` selected `todos`
alone, so no heavy suite was implicated and the machine-wide heavy lock — held
by another lane's `os/boot.js` throughout — was never contended.

- `node todos/liabilities.js check` → exit 0 (49 entries, 5 pinned, 42 funded)
- `node tests/run.js todos` → exit 0 (3/3), zero `REFUSING` markers
