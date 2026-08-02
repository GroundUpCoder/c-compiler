# #117 (0311) — setjmp contexts C11 7.13.1.1p4 requires: switch / while / else-if (+ expression statement)

The setjmp lowering only transformed `SIf` nodes whose condition matched the
pattern set, so three contexts the standard *requires* were rejected outright:
`switch (setjmp(b))`, `while (setjmp(b) == 0)`, `else if (setjmp(b))` — and the
diagnostic advertised `if (setjmp(buf) == 0)` while rejecting the identical
comparison in while-position. Re-derived at 99435f0c before touching anything:
all three probes rejected with the ticket's exact message (emitted by the
residual check in `lowerSetjmpLongjmp`), and the bare-assignment control
`r = setjmp(b);` rejected too (correct — not in p4's list).

## What each fix actually was

- **else if** — a missing recursion, as the ticket predicted. The transform
  machinery works on a compound's statements array (it splices in the
  arm/try/catch scaffold), and an `else if` is an `SIf` in a non-compound else
  slot the walker never entered. New `lowerSetjmpInStmt` wraps a non-compound
  statement that contains a setjmp in a synthesized one-statement compound and
  recurses; applied to if-branches, loop/switch/try bodies uniformly. The wrap
  bounds the retry scaffold's coverage to that statement — same pre-existing
  rule as any nested compound (coverage extends to the end of the enclosing
  compound), just made reachable.
- **while** — rewritten to the canonical if-shape with the loop preserved as a
  body wrapper, keyed on which path the condition makes true:
  - direct path true (`while (setjmp(b) == 0)`): "loop until a longjmp
    arrives" → `if (cond) { while (1) BODY }`; the longjmp lands in the catch,
    which *is* the loop exit.
  - jump path true (`while (setjmp(b))`): body runs once per longjmp, then the
    re-evaluated setjmp returns 0 and the loop exits → `do BODY while (0)`.
  break/continue bind to the wrapper with original semantics (continue
  re-evaluates a condition whose direct-path value is constant). Not re-arming
  per iteration is unobservable: the catch matches on buf[0], which a re-arm
  would only refresh, and the resume point is identical.
- **switch** — the one needing real thought: the accepted forms all collapse to
  a two-way branch, a switch doesn't, and duplicating the body across
  firstBody/jumpBody would duplicate its labels. Solution: hoist the value.
  `switch (setjmp(b)) BODY` becomes `int __sv = 0; if ((__sv = setjmp(b))) ;
  switch (__sv) BODY` — the existing `(v = setjmp(buf))` assignTarget machinery
  already delivers 0 on the direct path and the 0→1-coerced (7.13.2.1p4)
  longjmp value in the catch, and the retry scaffold re-runs the switch with
  the fresh value, which is exactly a longjmp's return into the controlling
  expression. Restricted to prefix-free, assignment-free shapes: p4 includes
  neither, and the comma/assign extensions exist only for the historical
  if-idioms (micropython's `nlr_push`).
- **expression statement** (`setjmp(b);` / `(void)setjmp(b);`) — also a
  p4-required context, found while enumerating p4 against the code; rewritten
  to the if-shape with an empty branch (the statement is just the arm point).
  Matched with `getNamedCall`, deliberately NOT `unwrapSetjmpAssign` — the UB
  bare assignment must keep rejecting, and the red demo below proves the
  distinction is load-bearing.
- **diagnostic** — now describes the real accepted set (if/while forms, switch,
  expression statement). One stderr golden pinned the old wording
  (`tests/unit/stdlib/setjmp_unsupported_diag`) and was updated; its rejected
  form (`setjmp(buf) + 1`) stays rejected.

## What was deliberately NOT done

`do`/`for` controlling expressions and comparisons against nonzero integer
constants (`if (setjmp(b) == 2)`) are also p4-required and still reject. The
do/for rewrite is real machinery — a first-iteration `break`/`continue` crosses
the arm point, so the simple wrapper is wrong and a scope-aware
break/continue redirection is needed — for forms with essentially zero
real-world usage. Surfaced, not silently cut: filed as **#432**, register entry
**L76** replaces L31, residue bullet in CONFORMANCE-REMAINING.md. The
nonzero-constant shape generalizes from the switch lowering when #432 runs.

## Evidence discipline

Test-first: 5 runtime conformance dirs (`sj_switch_ctrl`, `sj_while_eq0_ctrl`,
`sj_else_if_ctrl`, `sj_while_direct_ctrl`, `sj_expr_stmt`; clang-verified
goldens, longjmp round-trip values observed, incl. the 0→1 coercion) + 1 diag
dir (`diag_setjmp_assign_stmt`) pinning the UB rejection. All 5 runtime tests
shown RED pre-fix (compile rejection). Behavior-level reds: sabotaging the
catch's value delivery reddened the three value-observing tests; dropping the
while wrapper's body reddened both while tests; legalising the bare assignment
reddened the diag test (exit 0 vs expected 1). Unit suite 807 → 813 tests
(+6, enrollment proven by the moved total); 809 passed / 1 xfail / 3 skip
after.

**The `setjmp` libc-test stays skipped — that is correct**, its line 23 is the
UB bare-assignment form. run.py's reason text updated to mark the 0311
citation historical.
