# 0302 — recurring liability sweep: find gap-describing comments that never entered todos/

- **Status**: open
- **Design**: this file + `todos/LIABILITIES.md` (the register this pass fills)
  and `todos/0286` (the register + its checker). The 2026-07-27 unfunded-liability
  sweep was run #1; this item is the cadence that keeps it happening.

## Goal

The **discovery half** of the liability register. `todos/liabilities.js check` guarantees the
*register → tree* direction: nothing enrolled can rot without failing a gate. It cannot
guarantee the *tree → register* direction — "is every gap comment enrolled?" is not decidable
by machine, and a marker lint (`grep TODO`) would have found **zero** of the 12 findings the
2026-07-27 sweep produced, because the dangerous comments are well-written, accurate, and carry
no marker.

So that direction is a **recurring human/agent pass**, and it is funded here rather than
recorded as a limitation. An unfunded limitation is precisely the class the register exists to
kill — leaving one at the base of the register would be the joke telling itself.

## Reseed rule — ONE open copy, successor seeded at close

Same cadence discipline as `manual-ux-sweep` (don't rebuild the pile of overlapping copies).
At CLOSE time, in the closing commit:

    ls todos/*-liability-sweep.md    # must list ONLY this file
    node todos/queue.js add next --slug liability-sweep --priority 3 --difficulty medium

Then `node todos/queue.js check` and close this one, noting in the successor's body which
slices this run covered so the rotation advances.

## Plan

- **Pick a slice** (a non-exhaustive rotation — record what you skipped): `compiler.js` ·
  `host.js`/BlockFS · `kernel.js` · `os/` C sources · `os/win32/` veneer · `tests/` (vacuous
  legs + skip tables) · `vendor/*/README.md` patch tables · `todos/*.md` topic docs
  (lanes/phases left "open" in a design doc are unscheduled work that reads as scheduled) ·
  `CLAUDE.md` itself.
- **Read for the shape, not for a marker.** The question is never "is this comment accurate?"
  — assume it is. The question is:

  > **If this sentence is true, does it imply work?**

  Bucket every hit: *funded* (a live ticket already covers it) · *stale* (the comment is now
  false — fix it, that class is self-limiting) · **unfunded** (true, implies work, no ticket —
  the finding).
- **Sharper sub-shapes worth grepping for by hand**, all of which produced real findings:
  - *"deferred until X"* where **X has already shipped** — check every deferral target against
    `todos/done/`. (The checker now catches this for enrolled entries; the sweep finds the
    unenrolled ones.)
  - A pointer at a **closed** item, which reads as "handled" to anyone who does not look.
  - "no current consumer" — check whether the OS has since grown consumers (`0288` had three).
  - A partially-funded list: some rows cite tickets, the rest blend in as if they did.
  - An assertion satisfied equally by "it works" and "it never happened" (`0287`).
- **File what you find**, then **enrol it**: every finding gets a ticket AND a
  `todos/LIABILITIES.md` entry in the same commit, so the next reader inherits a checked record
  rather than another true comment nobody re-reads.
- Do **not** fix the findings in this pass — triage and enrol. Fixing is the filed items' job.

## Acceptance

- A slice covered end to end, with the skipped slices named.
- Every unfunded finding has a ticket and a register entry;
  `node todos/liabilities.js check` passes with the new entries.
- A dev-log entry (`logs/YYYY-MM-DD/liability-sweep.md`) with the funded/stale/unfunded split
  and the counts.
- Exactly ONE fresh `liability-sweep` successor seeded at close; `node todos/queue.js check`
  passes.
