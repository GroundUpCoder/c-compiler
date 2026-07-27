# 0360 — tests/run.js's compiler.js diff rule under-selects: no run.py category is gated by a compiler change

- **Status**: open
- **Priority**: P0 — a shipped gate (`tests/run.js --diff`, todos/0084) reports
  a green that does not mean what it says. Filed per the "any bug found from
  anywhere is P0" rule; demote if the queue disagrees.
- **Difficulty**: light (the fix is one RULES entry; the judgement is which
  categories belong in it)
- **Design**: `tests/run.js` (the `RULES` array), `todos/0318` (the vendor→suite
  rule block and its "a catch-all HIDES under-scheduling" lesson)

## Goal

`tests/run.js`'s rule for the primary compiler is

```
[/^compiler\.js$/, ['unit', 'kernel', 'blockfs', 'host'],
  'the compiler drives every wasm binary + the single-file emit'],
```

The rationale string claims the widest possible blast radius — *every* wasm
binary — but the suite list names four suites, none of which is a `run.py`
category except `unit`. So a `compiler.js` edit does **not** select
`micropython`, `micropython-upstream`, `lua`, `sqlite`, `zlib`, `libpng`,
`freetype`, `cairo`, `projects`, `tcc`, `libc`, `ext`, `extra`, `ast`,
`sourcemap`, `disw`, `fuzz` or `fakegit` — i.e. essentially the whole
real-world-C corpus, which is exactly the part of the estate that a codegen or
semantics change breaks.

This is the 0318 lesson in a different costume: there it was a catch-all hiding
under-scheduling with no warning; here it is a rule whose *prose* overstates its
*list*, which is worse, because the comment reads as a deliberate, considered
scope decision.

## Evidence — todos/0356 is the firing example

todos/0356 was a `compiler.js` miscompile: `promoteExprType` collapsed a
bit-field wider than `int` to `unsigned int`, truncating a 52-bit operand to 32
bits in every binary expression.

- The **only** suite in the estate that caught it was `micropython-upstream`
  (three red files), because MicroPython classifies IEEE-754 by hand through a
  `uint64_t frc : 52` bit-field.
- `unit` was **green** on `origin/main` with the bug live — the conformance
  corpus had no >32-bit bit-field promotion case until 0356 added
  `parse_bitfield_wide_promote`.
- Therefore `node tests/run.js --diff` on the commit that introduced this bug
  would have gone green. The gate did not merely miss the bug; it would have
  affirmatively reported the change as covered.

## Plan

1. Decide the real closure for `^compiler\.js$`. The honest answer is probably
   "every `run.py` category plus `unit`/`blockfs`/`host`/`kernel`" — the
   `PY_CATEGORIES` constant already exists in the file (`^tests/run\.py$` uses
   it), so the rule can reuse it rather than re-listing.
2. Weigh the cost. The two halves of the `run.py` estate measured on
   2026-07-28 at roughly 40s and 393s wall-clock, and micropython at ~64s — so
   a full `run.py` fold is ~8 minutes, against a `kernel` suite the rule
   already pulls. That is affordable; if some category is genuinely
   compiler-independent, say which and why in the rationale rather than
   omitting it silently.
3. Audit the sibling rules for the same prose-vs-list gap — `^host\.js$`
   (`blockfs, kernel, sweep, host`) makes the same "the process runtime lives
   here" claim and likewise names no `run.py` category, even though `host.js`
   is what every `run.py` category executes its wasm under.
4. Whatever is deliberately excluded must be **stated** in the rationale
   string, per the 0318 convention.

## Acceptance

- `node tests/run.js --diff` on a `compiler.js`-only change selects the
  `run.py` categories, demonstrated by `--dry-run` output in the commit
  message.
- A regression guard: touching `compiler.js` selects `micropython-upstream`
  (the suite that actually caught 0356).
- Any category deliberately left out of the rule is named, with its reason, in
  the rule's rationale string.
