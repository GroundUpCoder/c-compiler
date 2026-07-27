# 0305 — libc: implement search.h (hsearch/insque/lsearch/tsearch families) — 4 skipped libc-tests

- **Status**: open
- **Design**: this file. Source: todos/0298 (libc skip-table triage).

## Goal

`<search.h>` does not exist on this target. Four musl libc-tests are skipped for it —
`search_hsearch`, `search_insque`, `search_lsearch`, `search_tsearch`
(`tests/run.py`, the "Library features not implemented" block). Implement the header and
un-skip all four.

Grouped as ONE item deliberately: these are four small, independent container helpers
behind a single POSIX header, and the work is one `search.h` + one TU, not four lanes.

## Evidence (verified 2026-07-27, re-derived from a clean tree)

Zero hits for every symbol, in **both** `compiler.js` and `ext/`:

```
hsearch hcreate hdestroy   → 0 hits
insque remque              → 0 hits
lsearch lfind              → 0 hits
tsearch tfind twalk tdelete→ 0 hits
```

There is no `search.h` anywhere in the tree. The four tests are genuinely blocked, not
mis-skipped (unlike `fnmatch`/`fdopen`/`utime`, which 0298 deleted as stale skips).

## Plan

- Add `search.h` + implementation. `ext/` is the natural home (the `fnmatch` precedent:
  `ext/include/fnmatch.h` + `ext/src/fnmatch.c`, pulled in by `__require_source()`), so
  the core `compiler.js` libc does not grow for four rarely-used containers.
- musl's own implementations are MIT and already vendored-adjacent in
  `vendor/libc-test`'s upstream project — porting beats writing (the repo's
  prefer-porting rule).
- `hsearch` is the only one with global state (one process-wide table, `hcreate`/
  `hdestroy`); the rest are pure.
- Delete the four `tests/run.py` skip entries and confirm the tests pass through the
  real runner, not just a direct compile.

## Acceptance

- `search_hsearch`, `search_insque`, `search_lsearch`, `search_tsearch` skip entries gone
  from `tests/run.py`.
- `python3 tests/run.py --types=libc` green with the pass count up by 4 and the skip
  count down by 4.
- The `todos/LIABILITIES.md` entry for these skips retired in the same commit.
