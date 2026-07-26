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
separate defect classes, not one:

1. **Six conversions entirely absent** — `%F %g %G %r %T %V`. They fall through to the
   literal-echo `default:` (`compiler.js:31106`), so `"%F"` renders as the two
   characters `%F`. The implemented set is exactly
   `C Y m d H M S a A b B e c I p j w u y U W x X Z z s % n t`.
2. **Width / `+` modifiers parsed but almost never consumed.** The `[+0][width]`
   parser exists (`compiler.js:31002-31016`) and **only `%C` reads it**
   (`:31018-31024`). `%Y` ignores it: `%05Y`→`2016` (want `02016`), `%+5Y`→`2016`
   (want `+2016`), `%02Y`→`0000` (want `00`).
3. **Integer overflow on extreme `tm_year`.** `tp->tm_year + 1900` is computed in
   `int`, so a near-`INT_MAX` `tm_year` wraps: `%Y` → `-2147481749` where musl gives
   `+2147485547`. Same wrap reaches `%s`. *This one is a real correctness bug in
   shipped code, not a missing feature* — it just happens to be observable only
   inside this already-skipped test.
4. **`%y` wrong for negative years** — expected `47`, got `-49`.

A fifth failure class, the `%s` local-vs-UTC divergence (2 of the 40 lines, each
off by exactly this host's 32400 s), is **not** part of this item — it is a
semantics decision filed separately as **todos/0310**. Do not "fix" it here.

## Plan

- Add the six conversions. `%F`/`%T`/`%r` are compositions of existing pieces;
  `%g`/`%G`/`%V` need the ISO-8601 week-date computation (one helper, shared —
  `%V` and `%G` must agree).
- Route `__fmt_width`/`__fmt_plus` through `%Y`, `%F`, `%G` (the C23 set), not just
  `%C`. Note `%05Y` on a 5-digit year must **not** emit the `+` (`10009`, not
  `+10009`) — width suppresses the musl `+`.
- Widen the year arithmetic (`long long`) so class 3 cannot wrap.
- Then `strptime()` over the same table.

## Acceptance

- `strptime` and `strftime` skip entries gone from `tests/run.py`.
- `python3 tests/run.py --types=libc` green with the pass count up by 2 and the skip
  count down by 2 — which requires todos/0310 resolved too, since `%s` is asserted by
  the same test. Sequence accordingly.
- The `todos/LIABILITIES.md` entries for these skips retired in the same commit.
