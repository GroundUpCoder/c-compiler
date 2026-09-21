# 0356 — MicroPython float builtins raise OverflowError where upstream expects ValueError (3 red micropython-upstream tests)

- **Status**: done
- **Priority**: P0 — a shipped feature (`vendor/micropython`, the `micropython`
  package) is wrong, and it keeps a MAPPED suite RED
- **Design**: `vendor/micropython/README.md` (the dialect's recorded gaps),
  `todos/done/0117-micropython-*.md` (R1/R2, which took the corpus to
  610 passed / 3 failed / 65 skipped)

## Goal

Three files in the `micropython-upstream` corpus fail, and they are the whole
of that category's remaining redness:

```
micropython-upstream/float/builtin_float_round.py
micropython-upstream/float/math_domain.py
micropython-upstream/float/math_fun_int.py
```

`tests/run.js`'s RULES map `^vendor/micropython/` — *including its README* — to
the `micropython` / `micropython-upstream` categories, so **any** change under
that directory makes `node tests/run.js --diff` red through no fault of its
own. Found incidentally while landing `todos/0338` (which touched only
`vendor/micropython/README.md`); reproduced identically on a pristine
`origin/main` worktree, so it is pre-existing and not 0338's.

## What it actually is

At least `builtin_float_round.py` is a ONE-LINE diff: the last expected line is
`<class 'ValueError'>` and we print `<class 'OverflowError'>` — every numeric
value above it matches exactly. So this is not a float-math bug; it is the
**exception CLASS** chosen on a non-finite/out-of-domain conversion. The other
two are in the same family (`math_domain`, `math_fun_int`) and should be
checked for the same root cause before assuming three separate fixes.

Reproduce one at a time (a comma-joined `--filter` matched nothing here — pass
one name per run):

```
node tests/run.js micropython-upstream --filter=builtin_float_round
node tests/run.js micropython-upstream --filter=math_domain
node tests/run.js micropython-upstream --filter=math_fun_int
```

## Plan

1. Diff each of the three and confirm whether all three reduce to the same
   ValueError-vs-OverflowError choice. If they do, this is one fix.
2. Find where the conversion raises — likely the port's float→int path
   (`vendor/micropython/` port sources) or an upstream `MICROPY_*` config
   choice in `mpconfigport.h` that trades the two. If it is a config knob,
   note that `vendor/micropython/genhdr/*` is GENERATED — rerun
   `node tools/mkmpgenhdr.js` (its `--check` is the `micropython/genhdr-sync`
   test).
3. Fix, or — if any of the three turns out to be an upstream test that cannot
   hold for this dialect — record it in `vendor/micropython/README.md`'s gap
   list and SKIP it in the corpus, so the category is green and the exclusion
   is visible. A permanently red category is the anti-pattern (the fakegit/0183
   lesson).

## Acceptance

- `node tests/run.js micropython micropython-upstream` is GREEN.
- Whatever is not fixed is skipped WITH a written reason in
  `vendor/micropython/README.md`, not left failing.
