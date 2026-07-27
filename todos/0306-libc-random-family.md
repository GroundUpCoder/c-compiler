# 0306 — libc: implement the BSD random()/srandom()/initstate()/setstate() family

- **Status**: open
- **Design**: this file. Source: todos/0298 (libc skip-table triage).

## Goal

The BSD PRNG family is absent, so the musl `random` libc-test is skipped
(`tests/run.py`, "Library features not implemented"). Implement it and un-skip.

## Evidence (verified 2026-07-27, re-derived from a clean tree)

Zero hits in **both** `compiler.js` and `ext/` for `random` (as a whole word),
`srandom`, `initstate`, `setstate`. The only near-match is `emscripten_random`
(`compiler.js:23398, 27701, 27716`) — a different, unrelated host import; `\brandom\b`
does not match inside it. `rand`/`srand` (C89) exist and are NOT this family.

## Plan

- `random()` is a trinomial additive-feedback generator with a documented state
  layout (TYPE_0..TYPE_4, default 128-byte / TYPE_3 state). The test asserts the
  **exact** classic output sequence, so a bespoke PRNG will not pass — port musl's
  `random.c` (MIT).
- `initstate`/`setstate` need the state-array-with-header convention (degree +
  separation encoded in word 0) for `setstate` to accept a previously-`initstate`d
  buffer.
- `ext/` is the likely home (the `fnmatch` precedent) unless a caller in the OS image
  needs it link-free from core libc.

## Acceptance

- The `random` skip entry gone from `tests/run.py`.
- `python3 tests/run.py --types=libc` green with the pass count up by 1 and the skip
  count down by 1.
- The `todos/LIABILITIES.md` entry for this skip retired in the same commit.
