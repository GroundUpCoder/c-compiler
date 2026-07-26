# 0312 — longjmp in non-statement position crashes the compiler with a raw JS stack trace instead of diagnosing

- **Status**: open
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
