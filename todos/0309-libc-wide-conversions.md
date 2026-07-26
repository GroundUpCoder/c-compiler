# 0309 — libc: wide-char conversions — wcstol family + wide scanf (fwscanf/swscanf/vfwscanf)

- **Status**: open
- **Design**: this file. Source: todos/0298 (libc skip-table triage).

## Goal

Un-skip the two wide-character input musl libc-tests, `wcstol` and `fwscanf`
(`tests/run.py`, "Library features not implemented").

Grouped as ONE item deliberately: wide `scanf` numeric conversions are specified in
terms of the `wcsto*` functions, so implementing `fwscanf` without them means writing
them anyway. One lane, one wide-input pass.

## Evidence (verified 2026-07-27, re-derived from a clean tree)

Zero hits in **both** `compiler.js` and `ext/` for: `wcstol`, `wcstoul`, `wcstod`,
`fwscanf`, `swscanf`, `vfwscanf`.

## Plan

- `wcstol`/`wcstoul`/`wcstoll`/`wcstoull`/`wcstod`/`wcstof`/`wcstold` first. The
  narrow `strto*` implementations already exist; the cheap correct route is a
  wide→narrow transcode of the numeric prefix rather than a second parser, provided
  the `endptr` is mapped back to the **wide** position.
- Then `fwscanf`/`swscanf`/`vfwscanf`/`vswscanf` over the existing narrow scanf
  conversion machinery.
- NB `wchar_t` here is 4-byte (the win32 veneer's 2-byte `WCHAR` is a separate,
  veneer-local type — see the `windows.h` note in CLAUDE.md). These are the 4-byte
  libc ones; do not conflate.
- Check the interaction with the locale skips already in the table
  (`clocale_mbfuncs`, `mbc`, `swprintf` are all skipped for "no langinfo/locale
  beyond C") — if wide scanf's failures turn out to be locale-bound rather than
  missing-function, that is a different item and should be said so out loud, not
  absorbed silently.

## Acceptance

- `wcstol` and `fwscanf` skip entries gone from `tests/run.py`.
- `python3 tests/run.py --types=libc` green with the pass count up by 2 and the skip
  count down by 2.
- The `todos/LIABILITIES.md` entries for these skips retired in the same commit.
