# 0307 — libc: strptime() + the six missing strftime conversions (%F %g %G %r %T %V) and width modifiers

- **Status**: open
- **Design**: this file. Source: todos/0298 (libc skip-table triage).

## Goal

Un-skip two musl libc-tests — `strptime` (function absent entirely) and `strftime`
(present, but incomplete and wrong in four distinct ways).

Grouped as ONE item deliberately: `strptime` parses exactly the `%` conversion
vocabulary `strftime` formats, so a lane that adds `%F %g %G %r %T %V` to the formatter
already owns the table `strptime` needs. Splitting them duplicates that table.

## Evidence (verified 2026-07-27, re-derived from a clean tree)

**`strptime`**: zero hits in **both** `compiler.js` and `ext/`. Genuinely absent.

**`strftime`** (`compiler.js:30992`): direct compile+run of
`vendor/libc-test/src/functional/strftime.c` → **exit 1, 40 diagnostics**. Four
separate defect classes, not one. **Fix class 1 FIRST** — it is the only one that is a
wrong answer from shipped code rather than an absent feature:

1. **`tm_year + 1900` overflows `int` — SHIPPED CODE, WRONG ANSWER.** The addition is
   done in `int` at `compiler.js:31027-31028`, `:31058-31059`, `:31070` and `:31078`,
   so a near-`INT_MAX` `tm_year` wraps. The same wrap reaches `%s`.

   Observed vs musl, verbatim:

   | format | expected | got |
   |---|---|---|
   | `%Y` | `+2147485547` | `-2147481749` |
   | `%011Y` | `02147485547` | `-2147481749` |
   | `%s` | `67768036160140800` | `-67768040641276800` |

   The test targets this **deliberately** — it guards the block on
   `INT_MAX == 0x7FFFFFFF` with a comment noting the standard specifies no range for
   `tm_year`, then asserts the above against a near-`INT_MAX` `tm5`. It is not an
   incidental extreme-input artefact.

   It un-skips nothing on its own (the test stays skipped on classes 2–4 regardless),
   which is exactly why it must lead this item and appear in its acceptance rather
   than trail a list of missing conversions.

2. **Six conversions entirely absent** — `%F %g %G %r %T %V`. They fall through to the
   literal-echo `default:` (`compiler.js:31106`), so `"%F"` renders as the two
   characters `%F`. The implemented set is exactly
   `C Y m d H M S a A b B e c I p j w u y U W x X Z z s % n t`.
3. **Width / `+` modifiers parsed but almost never consumed.** The `[+0][width]`
   parser exists (`compiler.js:31002-31016`) and **only `%C` reads it**
   (`:31018-31024`). `%Y` ignores it: `%05Y`→`2016` (want `02016`), `%+5Y`→`2016`
   (want `+2016`), `%02Y`→`0000` (want `00`).
4. **`%y` wrong for negative years** — expected `47`, got `-49`.

A fifth failure class, the `%s` local-vs-UTC divergence (2 further lines, each off by
exactly this host's 32400 s), is **not** part of this item — it is a semantics
decision filed separately as **todos/0310**. Do not "fix" it here.

## Plan

- **First: widen the year arithmetic** (`long long` at all four sites above) so class 1
  cannot wrap. Do this before touching the conversions — everything else builds on the
  same year value, and a fix layered on top of an overflowing base is untestable.
- Add the six conversions. `%F`/`%T`/`%r` are compositions of existing pieces;
  `%g`/`%G`/`%V` need the ISO-8601 week-date computation (one helper, shared —
  `%V` and `%G` must agree).
- Route `__fmt_width`/`__fmt_plus` through `%Y`, `%F`, `%G` (the C23 set), not just
  `%C`. Note `%05Y` on a 5-digit year must **not** emit the `+` (`10009`, not
  `+10009`) — width suppresses the musl `+`.
- Then `strptime()` over the same table.

## Acceptance

- **`%Y`/`%011Y`/`%s` on a near-`INT_MAX` `tm_year` render `+2147485547`,
  `02147485547` and `67768036160140800` — no sign flip.** Because this is a wrong
  answer from shipped code and the libc test that exercises it stays skipped until the
  rest of this item lands, it needs its own guard that does NOT depend on the skip
  being lifted: a `tests/unit/conformance/` dir asserting those strings.
- `strptime` and `strftime` skip entries gone from `tests/run.py`.
- `python3 tests/run.py --types=libc` green with the pass count up by 2 and the skip
  count down by 2 — which requires todos/0310 resolved too, since `%s` is asserted by
  the same test. Sequence accordingly.
- The `todos/LIABILITIES.md` entries for these skips retired in the same commit.
