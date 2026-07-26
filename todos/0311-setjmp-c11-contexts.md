# 0311 — compiler.js rejects three setjmp contexts C11 7.13.1.1p4 REQUIRES (switch, while(==0), else if)

- **Status**: open
- **Design**: this file. Source: todos/0298 close-out; the gap itself was recorded as
  prose in `todos/CONFORMANCE-REMAINING.md` and had never entered the queue.

## Goal

`setjmp` is accepted in only a subset of the contexts C11 mandates. Three forms the
standard **requires** an implementation to accept are rejected outright.

**Read this before you start: fixing this will NOT un-skip the `setjmp` libc-test.**
`vendor/libc-test/src/functional/setjmp.c:23` uses the bare-assignment form
`r = setjmp(jb);`, which is UB per C11 7.13.1.1p4 and which we reject *correctly*.
That test stays skipped afterwards (`tests/run.py`, reason text cites this item). Do
not file or close this as a test-unblocking item and then report it "failed" — its
verification is the conformance corpus, not the libc suite.

## Evidence (probed 2026-07-27 against this tree, not inferred)

All three compile to the SAME rejection:

```
error: unsupported use of setjmp — only forms like 'if (setjmp(buf))',
'if (!setjmp(buf))', 'if (setjmp(buf) == 0)', or 'if ((v = setjmp(buf)))' are supported
```

| form | C11 status | ours |
|---|---|---|
| `switch (setjmp(b))` | entire controlling expression of a selection statement — **required** | rejected |
| `while (setjmp(b) == 0)` | equality against an integer constant expression, the entire controlling expression of an iteration statement — **required** | rejected |
| `else if (setjmp(b))` | entire controlling expression of a selection statement — **required** | rejected |
| `r = setjmp(b);` | not in p4's list — **UB** | rejected (correct) |

C11 7.13.1.1p4 permits the `setjmp` macro invocation to appear as: the entire
controlling expression of a selection or iteration statement; one operand of a
relational or equality operator with the other a integer constant expression, with
the resulting expression being the entire controlling expression of a selection or
iteration statement; the operand of a unary `!` with the result being that entire
controlling expression; or the entire expression of an expression statement
(possibly cast to `void`).

**The diagnostic is also self-inconsistent**: it advertises `if (setjmp(buf) == 0)` as
supported while rejecting `while (setjmp(b) == 0)` — the identical comparison in the
other required statement form. Whatever fixes the acceptance must fix the message too,
or the message will send the next reader to a form that also does not work.

## Plan

- The restriction lives in the parser's setjmp special-casing (the site that emits the
  message above). The existing accepted set is `if`-shaped only; widen it to the p4
  grammar — selection **and** iteration statements, and `else if` (which is just a
  selection statement in the else branch, so this one is likely a missing recursion,
  not new machinery).
- `switch (setjmp(b))` is the one that needs real thought: the accepted forms all
  collapse to a two-way branch, and a switch does not.
- Add conformance-corpus dirs (`tests/unit/conformance/`) for the three forms.
  These assert a *required acceptance*, so they are ordinary runtime tests with an
  `expected.stdout`, not `diag_*` dirs. Test-first per CLAUDE.md.
- Keep rejecting `r = setjmp(b);`, and keep a `diag_*` test pinning that rejection so a
  future widening does not accidentally legalise the UB form.

## Acceptance

- `switch (setjmp(b))`, `while (setjmp(b) == 0)` and `else if (setjmp(b))` all compile
  and behave correctly across a `longjmp` round trip, pinned by conformance tests.
- The diagnostic's suggestion list matches what is actually accepted.
- `r = setjmp(b);` still rejected, pinned.
- The `todos/CONFORMANCE-REMAINING.md` bullet retired and its
  `todos/LIABILITIES.md` entry (L31) retired in the same commit.
- The `tests/run.py` `setjmp` skip entry stays — update its reason text to say the
  citation is now historical rather than fundable, since line 23 is UB.

## See also

todos/0312 — `longjmp` in non-statement position crashes with a raw JS stack trace.
Same code region, filed separately because that one is a compiler crash on valid C11
and is prioritised accordingly.
