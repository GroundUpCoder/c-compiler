# 0312 — longjmp in non-statement position crashes the compiler with a raw JS stack trace instead of diagnosing

- **Status**: DONE 2026-07-27 — took the **support** route, not diagnose-only. See
  "Outcome" at the bottom.
- **Priority**: P0 — a compiler crash on valid C11. See "Priority" below; demote if you
  disagree, but do it explicitly.
- **Design**: this file. Source: todos/0298 close-out; the gap itself was recorded as
  prose in `todos/CONFORMANCE-REMAINING.md` and had never entered the queue.

## Goal

`longjmp` outside statement position does not produce a diagnostic — it throws an
uncaught JS exception out of the compiler.

## Evidence (probed 2026-07-27 against this tree, not inferred)

```c
#include <setjmp.h>
static jmp_buf b; static int n;
int main(void){
  if (setjmp(b)) { printf("done\n"); return 0; }
  n ? longjmp(b,1) : longjmp(b,2);      /* <-- */
  return 0;
}
```

```
compiler.js:19509
  if (funcIdx === undefined) throw new Error(`emitExpr: function '${funcDef.name}' not found`);
                             ^
```

A raw Node stack trace with no file, no line, no source context. Same for the other
non-statement positions named in `todos/CONFORMANCE-REMAINING.md`: a for-increment and
a return expression.

**This input is valid C11.** Unlike `setjmp`, the standard places no context
restriction on `longjmp` — it is an ordinary function call and may appear in any
expression. So this is not "we reject an exotic form"; it is the compiler falling over
on conforming code.

## Priority

Filed **P0** under CLAUDE.md's standing rule ("any bug found from anywhere is filed P0
unless the user explicitly says otherwise") because it is a defect in shipped
behaviour, not a missing feature: valid input, no diagnostic, internal crash.

The counter-argument, stated so it does not have to be rediscovered: the trigger is
rare in real code, and the gap has been documented (unfunded) in
`CONFORMANCE-REMAINING.md` for a long time, so it is not a regression. If that wins,
`node todos/queue.js set-priority 0312 1` — but make it a decision, not a drift.

## Plan

Two separable outcomes, and the cheap one is worth having on its own:

- **Minimum: diagnose.** Match what `setjmp` already does — a proper
  `file:line: error:` naming the unsupported position. That converts a crash into a
  compile error and is the "add the longjmp counterpart" the
  `CONFORMANCE-REMAINING.md` bullet asks for. `diag_*` conformance dir
  (`expected.compiler.exitcode`, no stderr golden).
- **Correct: support it.** `longjmp` is a normal call; the reason it is special-cased
  at all is the setjmp/longjmp lowering. Supporting arbitrary expression position is
  the conforming answer, and it is what removes the gap rather than labelling it.
  Do not stop at the diagnostic and call the item done — build to the goal.

## Acceptance

- `x ? longjmp(b,1) : longjmp(b,2)`, `for (…; …; longjmp(b,1))` and
  `return longjmp(b,1), 0;`-shaped inputs no longer produce an uncaught JS exception.
- Whichever route: pinned by conformance tests (runtime tests if supported, `diag_*`
  if diagnosed).
- The `todos/CONFORMANCE-REMAINING.md` bullet retired and its
  `todos/LIABILITIES.md` entry (L32) retired in the same commit.

## See also

todos/0311 — the three C11-required `setjmp` contexts we reject. Same code region.

## Outcome (2026-07-27)

**Supported, not diagnosed.** The residual is no longer a crash *or* an error — the
input compiles and runs, matching native clang byte-for-byte on all four shapes.

The mechanism, one paragraph: `lowerLongjmpInStmt` only ever handled `longjmp` in
STATEMENT position, because that is the one shape where the lowering's product — a
`__throw __LongJump(buf[0], val)` STATEMENT — can replace what it found. Every other
expression slot has nowhere to put a statement, which is why the call survived to
codegen and died on a `longjmp` that had already been stripped from
`importedFunctions`. The fix gives the throw a statement home of its own: a new libc
function `__setjmp_throw(int id, int val)` in `__setjmp.c` whose entire body is that
throw. A residual `longjmp(buf, val)` anywhere in an expression is rewritten to
`__setjmp_throw(buf[0], val)` and the exception unwinds out of that frame into the
enclosing setjmp's catch. `longjmp` never returns, so the extra frame is
unobservable, and the rewrite needs **no** structural analysis of the enclosing
expression — it composes with arbitrary nesting for free.

Two new pieces in `compiler.js`'s setjmp section: `rewriteLongjmpExpr` (an
`AST.walkExpr` visitor) and `rewriteLongjmpInStmt` (a statement walker that feeds it
every expression slot). The statement walker enumerates shapes rather than driving
off the generic `children` array because `SFor`'s children array is variadic — its
`_withChildren` deliberately throws — and `SDecl`'s children mirror initializers that
actually live on the `DVar`s.

Pinned by four clang-verified conformance dirs: `sj_longjmp_ternary`,
`sj_longjmp_for_increment`, `sj_longjmp_return_expr`, `sj_longjmp_declarator_init`.
The last one covers the declarator-initializer slot, which is not one of the three
shapes the ticket named but is a distinct branch of the new walker.

**Statement position is untouched** — it still lowers to the inline throw, and a
`--gc-sections` build of a setjmp program is byte-identical to pre-fix output.
Without `--gc-sections` a setjmp-using binary grows by 5 bytes (the now-unreferenced
`__setjmp_throw`); that is the whole cost, and it is deliberate: one code path beats a
conditional `__require_source` that a standalone `lowerSetjmpLongjmp` caller could
skip.

**todos/0311 is NOT affected.** `switch (setjmp(b))` still reports the same
`unsupported use of setjmp` diagnostic — verified after the fix. The setjmp residual
check is a separate code path and this change does not reach it.

Retired in the same commit: the `CONFORMANCE-REMAINING.md` bullet and register entry
**L32** (whose anchor was that bullet's first line).
