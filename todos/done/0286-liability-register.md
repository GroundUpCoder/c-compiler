# 0286 — Liability register: gap comments must cite a ticket, machine-checked so a closed-item citation FAILS the suite

- **Status**: open
- **Design**: this file. Source: the unfunded-liability sweep of 2026-07-27, whose
  *own* recommendation this is — it is the structural fix for the class the sweep found,
  rather than another instance-by-instance cleanup.

## Goal

Make "a comment that names an unclosed gap" a **machine-checked** claim instead of prose that
nothing re-reads.

The sweep's finding was not that any one comment was wrong. It was that **a TRUE comment naming
an unclosed gap is more dangerous than a false one**:

- A **false** comment is *self-limiting* — it contradicts behaviour, something breaks, someone
  catches it. Every false comment the sweep found had been caught *because* it was false.
- A **true** one is *self-perpetuating* — it reads as known and handled, it confers legitimacy,
  and **the documentation IS the reason nobody looks again.**

So the useful question is not *"is this comment accurate?"* but **"does it describe a GAP, and
is that gap SCHEDULED anywhere?"** The sweep bucketed ~40 gap-describing comments and found
**12 unfunded** ones. All 12 survived by the same mechanism: **they never entered `todos/`.** A
scheduling system is only as good as what it is asked about.

Two sharper corollaries, both of which produced real findings:

- **A deferral can outlive its own premise.** `0291` (`listdir.h` → deferred to a redesign that
  has since shipped and closed) and `0288` (`0162` deferred for "no current consumer" when
  three shipped apps are consumers today) are both *"deferred until X"* where **X already
  happened** and nobody reopened them. A deferral needs its unblocking condition recorded in a
  form something can **CHECK**, or it silently becomes permanent.
- **A pointer at a closed item reads as "handled."** `0291`'s comment points at
  `todos/done/0250`. It looks handled to anyone who does not notice `0250` is in `done/`.

## Precedent (this is not a new idea in this repo)

The one pattern here that structurally cannot rot is **`os/win32/PORTS.md`**: an
unimplemented-symbol log that is **regenerated and machine-checked in the kernel suite**. It
cannot drift, because drifting fails a test. Every finding in the sweep, by contrast, is a gap
recorded in prose that nothing re-reads. Extend the PORTS.md idea to liabilities.

## Plan

- A checked-in **liability register** (e.g. `todos/LIABILITIES.md`, or a structured sibling)
  whose entries each cite: the code location, one line on the gap, and a **ticket id**.
- A `tests/run.js` rule (or a `todos/queue.js check` rule — decide which owner is right; the
  queue CLI is already the single writer + validator for ticket state) that **FAILS when an
  entry cites an item that is in `todos/done/`**, i.e. exactly the "deferral outlived its
  premise" shape. Findings `0291` and `0300` would both have fired.
- Decide and record the **enrolment rule**: what obliges a gap-describing comment to appear in
  the register at all. A register nothing is required to join is itself an unfunded liability —
  do not ship the checker without answering this.
- Seed the register with the sweep's 12 findings, now filed as `0285`, `0287`–`0301`.

**Do not** reach for a lint that greps for `TODO`/`XXX` and calls it done. The sweep's whole
point is that the dangerous comments are *well-written, accurate, and carry no marker* — a
marker-based lint would have found none of the 12.

## Acceptance

- The register exists, is populated with the sweep's findings, and every entry cites a live
  ticket id.
- A test fails when an entry cites a **closed** (`todos/done/`) item — demonstrated by
  temporarily pointing an entry at a done id and showing the failure, then reverting.
- The enrolment rule is written down, not merely implied.
- `node todos/queue.js check` passes; planner-selected suites green, reported with NUMBERS.
