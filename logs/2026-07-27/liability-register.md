# The liability register (todos/0286) — a gap comment must cite a live ticket, machine-checked

`todos/LIABILITIES.md` + `todos/liabilities.js` + the `todos` suite in `tests/run.js`.
Seeded with the 2026-07-27 unfunded-liability sweep's findings (`0285`, `0287`–`0301`).

## The thing being defended against

Not inaccurate comments. **Accurate** ones. A false comment is self-limiting — it contradicts
behaviour, something breaks, someone catches it; every false comment the sweep found had already
been caught *because* it was false. A true one is self-perpetuating: it reads as known and
handled, it confers legitimacy, and **the documentation is the reason nobody looks again.**

So the checked question is never "is this comment accurate?" but "**does it describe a GAP, and
is that gap SCHEDULED?**" All 12 unfunded findings survived by one mechanism: they never entered
`todos/`.

## Owner decision: `tests/run.js` owns the gate, `queue.js` co-signs it

0286 left this open, observing (correctly) that the queue CLI is already the single writer +
validator for ticket state. Both, then — but the **gate** is `tests/run.js`:

- **`queue.js check` alone is failure mode (C) again.** Grepped: its only automatic invoker is
  `todos/githooks/pre-commit`, which is **opt-in per clone** (`git config core.hooksPath …`),
  and *nothing in the estate ran it* — `tests/run.js` IGNOREd all of `todos/`, and
  `todos/queue.test.js` was run by no suite at all. A validator whose only trigger is opt-in
  local config is prose with an exit code. Shipping the register behind it would have reproduced
  the exact shape the ticket exists to kill.
- **`tests/run.js --diff` is the gate every lane provably runs** — it is the literal acceptance
  line on essentially every item in the queue.
- **Ticket state is only half the rot.** An entry also dies when the *code* changes: someone
  rewrites the anchored comment and the entry silently stops describing anything. That is not a
  ticket-state event, so `queue.js` would never see it. The diff planner does — and now must:
  the rule table asks the register for the files it cites, so **a new entry enrols its own file
  in the rule table** with no rule for anyone to remember.
- **Conversely, closure is a queue event and worth catching at the closing commit**, so
  `queue.js check` runs the same module (hence the hook), and `queue.js done <ID>` names the
  entries that close just made stale. One implementation, three invokers, none of them optional.

Concrete wiring: new `todos` suite (`tests/todos/run.js` → queue check, queue tests, register
check, register tests) at the front of `RUN_ORDER`; `todos/` removed from `IGNORE` and a `FORCE`
list added so the docs-shaped ignores (`\.md$`, `README`) cannot swallow the register or the
files it cites.

## Design decisions worth keeping

**Anchors, not line numbers.** An entry pins a *literal line* that must appear exactly once in
its file. A stored line number rots on the first unrelated edit above it, and a rotted-but-
plausible record is precisely this file's subject matter. `liabilities.js list` resolves anchors
to live `file:line` for reading, so nothing is lost and nothing is stored that can go stale.

**`defers-to` is a first-class field, not a heuristic.** The tempting implementation — grep the
anchor for 4-digit ids and fail if any is in `done/` — is unusable: this repo cites closed items
constantly as *provenance* ("added by 0171"). So deferral is declared (`defers-to`), history is
declared (`provenance`), and the backstop is mechanical: **every id in an anchor that names a
real todo must be classified as one or the other**, else the check fails. No guessing, no false
positives, and laundering a deferral through `provenance` is a deliberate lie rather than a
drift.

**`expired:` is an xfail pin, straight from the conformance corpus's `knownBug`.** `0291`,
`0293` and `0300` all defer to items that are already closed — they are RED by construction
today, and a permanently-red gate gets ignored (the fakegit/0183 anti-pattern). So the entry
acknowledges the expiry, the check reports it green-but-listed, and the pin **cannot outlive its
own premise** in any direction: the funding ticket must be open, a reopened target fails as
*xpass* ("the pin no longer applies"), a vanished comment fails as anchor drift, and closing the
ticket fails the entry outright. That is the ticket's own thesis applied to the mechanism it
asks for.

**Nothing may pass vacuously.** An empty register fails ("an empty register passes vacuously,
which is the failure mode this check exists to prevent"). A line inside the entry markers that
the parser does not understand fails instead of being skipped — a silently dropped entry is a
liability that stopped being checked without saying so. A register that will not parse makes
the planner treat **every** path as cited, so the `todos` suite runs on any diff at all and
reports the parse error: a broken register widens the gate rather than quietly opening it.

## Enrolment — answered, and funded

The rule (in `LIABILITIES.md` and `todos/README.md`): *if a comment's sentence is true, does it
imply work?* Then it needs a ticket and an entry, in the same commit. Explicitly **not** a
`TODO`/`XXX` lint — the 12 findings carried no markers, so a marker lint would have found zero
of them.

The checker guarantees the *register → tree* direction. The *tree → register* direction is not
machine-decidable, so it is **funded as `todos/0302`** (a recurring liability sweep, one open
copy, successor seeded at close — the `manual-ux-sweep` cadence) rather than written down as a
limitation. Leaving an unfunded limitation at the base of the liability register would have been
the joke telling itself.

## Demonstrated, not asserted

- Pointing `L13`'s ticket at `todos/done/0250`: `liabilities: FAILED … ticket 0250 is CLOSED` →
  `tests/run.js --diff` FAIL. Reverted → green. (`todos/liabilities.test.js` pins the same shape
  permanently, plus the anchor-drift, ambiguous-anchor, empty-register, unparsable-line,
  reopened-pin and unclassified-id cases — 28 cases, most of them RED cases.)
- Dropping every `expired:` pin from the real register fires all five expiries verbatim,
  including **`0291` (via `0250` and `0259`) and `0300` (via `wm.c` and `wm_proto.h`)** — the
  two findings 0286 named. A third, `0293`, fires with them.
- Rewriting `kernel.js`'s anchored resize-zone comment: `anchor not found in kernel.js — the
  line was edited or removed, so this entry no longer describes anything`.

## Numbers

`node tests/run.js --diff origin/main` → plan `todos` → **1 passed, 0 failed** (5.4s);
inside it: queue-check ok, `queue.js: 29 passed`, liabilities-check ok, `liabilities.js: 28
passed` — 4/4 cases. No image version bump: `todos/` + tooling only, nothing seeded into the
bake.
