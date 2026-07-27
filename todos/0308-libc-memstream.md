# 0308 — libc: implement open_memstream()/fmemopen() (memory FILE streams)

- **Status**: open
- **Design**: this file. Source: todos/0298 (libc skip-table triage).

## Goal

Memory-backed `FILE` streams do not exist, so the musl `memstream` libc-test is
skipped (`tests/run.py`, "Library features not implemented"). Implement
`open_memstream`, `open_wmemstream` and `fmemopen`, and un-skip.

## Evidence (verified 2026-07-27, re-derived from a clean tree)

Zero hits in **both** `compiler.js` and `ext/` for `open_memstream` and `fmemopen`.

## Plan

- These are POSIX `FILE`s whose backing store is a buffer, not an fd — so the work is
  entirely in whatever `FILE` abstraction `compiler.js`'s stdio uses. Check first
  whether that stdio has a cookie/vtable seam (`funopen`/`fopencookie` shape) or is
  hard-wired to fds; if it is hard-wired, adding that seam IS this item's real cost and
  is the thing to design, not the two entry points.
- `open_memstream` semantics that the test asserts: the caller's `char **`/`size_t *`
  are updated at every `fflush` **and** `fclose`, the buffer is always
  NUL-terminated past the reported length, and seeking past the end zero-fills.
- `fmemopen` in `"w"` mode must NUL-terminate within the caller's buffer;
  in `"a"` mode the initial position is the first NUL, not the buffer end.
- Worth doing beyond the test: an in-memory `FILE` is the natural way for OS-side
  code to reuse `printf`-family formatting into a buffer.

## Acceptance

- The `memstream` skip entry gone from `tests/run.py`.
- `python3 tests/run.py --types=libc` green with the pass count up by 1 and the skip
  count down by 1.
- The `todos/LIABILITIES.md` entry for this skip retired in the same commit.
