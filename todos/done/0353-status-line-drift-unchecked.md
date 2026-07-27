# 0353 — `queue.js check` does not validate Status lines, so tickets advertise the wrong state

- **Status**: done
- **Priority**: P3, light.
- **Provenance**: found 2026-07-28 by the router CHECK lane (one instance) and
  widened by master cont-113, which found the instance was a class and that the
  class had already cost real queue-rank damage.

## The defect

`statusOf` (`todos/queue.js:128-135`) reads a ticket's Status line **only for
open tickets** and substring-tests it for exactly one word, `deferred`.
Everything else about the line is unvalidated. Consequences, all measured on
2026-07-28:

- **36 of 260 tickets in `todos/done/` still say `- **Status**: open`** —
  including `0330`, which is cited as a dependency by `0340` and `0347` and is
  therefore precisely the ticket a lane WILL read.
- Worse, in the other direction: **`0117` sat at rank 1 of 91, `P0`, `ready`**
  with a line-3 Status reading *"R2 is the remaining work"* while its own §R2
  read *"DONE 2026-07-28"*. A lane taking the top ready item would have re-done
  work that had already shipped as micropython 1.28-3.
- **`0336`** sat at `P0` rank 1 after being demoted by decider verdict D2,
  because the decision never reached the queue row — the (BF) failure.

The directory is the real source of truth for done-ness, and priority lives in
`queue.json`; the Status line is documentation that nothing checks, so it
drifts. The cost is not cosmetic — it is a lane spending a turn on finished or
mis-ranked work.

## Scope — do the cheap, decidable half

1. **`check` fails when a ticket in `todos/done/` has a Status line whose first
   line says `open`.** Trivially decidable, and it closes the 36-ticket class.
2. **`check` fails when an open ticket's Status line contradicts a `## R<n> —
   DONE` / `— LANDED` heading in its own body** — i.e. the line claims a round
   is remaining that the body records as landed. Keep this narrowly pattern-
   matched; do not attempt general prose understanding.
3. `check --fix` should offer to rewrite (1) — it is mechanical. **Do NOT
   auto-fix (2)**: which side is right is a judgement call.

Fixing the 36 existing `done/` lines is part of this ticket, but do it as its
**own commit**, separate from the checker, so the checker's diff stays readable.

## Explicitly NOT in scope

Validating priority against a decision record. There is no machine-readable link
from a decider verdict to a queue row, and inventing one here would be a bigger
design than this ticket. The `0336` case is recorded above as motivation, not as
a requirement.

⚠️ **Parser footgun — do not break it** (documented in `0126`): `statusOf`
captures only the FIRST line after `Status:` and substring-tests it for
`deferred`, so writing "un-deferred" on that line silently re-defers a ticket.
Any change here must keep that behaviour or fix it deliberately with tests.

## Acceptance

- `node todos/queue.js check` goes RED on a `done/` ticket whose Status says
  open, and on a seeded open-ticket contradiction; GREEN after the fix commit.
- The 36 existing `done/` Status lines are corrected in a separate commit.
- A test covers the "un-deferred" footgun so it cannot regress.
- `node tests/run.js --diff` green (the `todos` suite is the relevant one).
