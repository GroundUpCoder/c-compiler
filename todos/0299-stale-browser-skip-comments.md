# 0299 — Correct the stale optional-browser-sweep-degrades-to-a-skip comments (tests/run.js:37, CLAUDE.md:147)

- **Status**: open
- **Design**: this file. Source: unfunded-liability sweep 2026-07-27, bucket 2 (stale/
  inaccurate comments — the class we generally *do* catch, because false comments are
  self-limiting).

## Goal

Fix a comment that advertises a tolerance narrower than reality.

`tests/run.js:37` (+ `:369-375`) and `CLAUDE.md:147` both say:

> the browser `sweep` is optional (a missing-Playwright launch failure degrades to a skip, not a
> hard fail)

**What actually happens:** the skip only fires on `r.spawnError`, i.e. failure to spawn the
**node process**. A missing Playwright is an import error *inside* `os-sweep.mjs`, which exits 1
or 2 (`os-sweep.mjs:68-69`) and therefore classifies as **fail**.

So the real behaviour is **stricter** than documented — a missing Playwright hard-fails the
sweep rather than skipping it. That is arguably the better behaviour; the defect is that the docs
promise otherwise, so a contributor without Playwright hits a hard failure the docs told them
would be a skip.

## Status — PLAUSIBLE, not CONFIRMED

The sweep read both code paths but **ran no suites**. **Verify by actually inducing it** (hide
Playwright, run the sweep, observe fail vs skip) before editing the comments. If it turns out to
skip after all, the finding is void — close this item and record that.

## Plan

- Reproduce: with Playwright unavailable, run the sweep and record the actual classification.
- Then either:
  - **(a)** correct `tests/run.js:37`, `:369-375` and `CLAUDE.md:147` to describe the real
    (stricter) behaviour; or
  - **(b)** if the documented tolerance is the *intended* behaviour, make the code match it —
    classify an in-process Playwright import failure as a skip.
- **Decide which of (a)/(b) is wanted rather than defaulting to the comment edit** — the docs
  may be describing the intent correctly and the code may be the thing that is wrong.

## Acceptance

- Documented behaviour and actual behaviour agree, verified by inducing the condition.
- The decision between (a) and (b) is recorded here with its reason.
- Planner-selected suites green (`node tests/run.js --diff`), reported with NUMBERS.
