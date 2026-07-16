# 0227 — Bug-hunt close-out: G21/G22/G23/W2 (sizeof semantics, accepts-invalid batch, empty-struct stride, WAST double-else)

- **Status**: done (2026-07-16) — G21/G23/W2 one commit each; G22 in three
  (pp / const-assignment sema / parser diagnostics), corpus-safe: the
  const check matches clang case-for-case (22-case differential oracle),
  fuzz corpus 105/105, SameBoy interlock byte-identical. Literal
  writability evaluated → deferred as todos/0228. **This completes the
  2026-07 bug-hunt agenda: G1–G23 + W1/W2 all landed.** Dev log:
  `logs/2026-07-16/bughunt-close-0227.md`.
- **Design**: —

## Goal

Close the FINAL four CONFIRMED findings from the 2026-07 fresh-eyes bug hunt
(G1–G7 + W1 landed via todos/0203–0209; G8–G20 via 0216–0225). This item
COMPLETES the bug-hunt agenda G1–G23 + W1/W2. All four are
front-end/preprocessor/WAST-validator — no codegen hot-path change.

- **G21** — the sizeof OPERATOR reads raw `type.size`: `sizeof(void)`,
  `sizeof(*voidp)`, `sizeof(func)` yield 0 (GNU: 1 — this compiler already
  adopts GNU stride-1 void* arith); sizeof of an INCOMPLETE type silently
  yields 0 instead of the C11 6.5.3.4p1 constraint error. Scope to the
  operator result — layout `sizeOf()` keeps 0 for void.
- **G22** — accepts-invalid batch, each currently silent, clang/gcc reject:
  assignment (+ incdec/compound) to const; negative array size; named/non-sole
  `void` parameter; invalid token paste (`a ## ++`); trailing `#` in a
  function-like macro body; `extern int y; static int y;` conflicting
  linkage; unknown directive `#frobnicate`.
- **G23** — pointer arithmetic over arrays of EMPTY structs uses stride 1
  (`&a[9]-&a[0]` == 9; gcc/clang 0 — empty struct is genuinely size 0 under
  the GNU extension; distinct from the G1 void clamp). Also EVALUATE (likely
  defer) string-literal writability: literals are deduplicated AND writable.
- **W2** — WAST `validate()` accepts two `else` clauses in one WIf; builder
  `else_()` doesn't mark else-seen. Defensive substrate hardening — no C
  producer emits this today.

## Plan

One commit per finding, test-first where a repro exists; conformance dirs
under `tests/unit/conformance/` (diag_* for constraint errors), ast test for
W2. Gate per commit: `node tests/run.js` (unit+conformance+ast). SameBoy
interlock once at the end (no codegen change expected).

## Acceptance

- sizeof(void)/sizeof(*voidp)/sizeof(func) == 1; sizeof(incomplete) errors.
- All seven G22 constructs diagnosed; full suite green (no corpus regression).
- `&a[9]-&a[0]` on empty-struct array == 0; indexing offset 0.
- validate() names the double-else instead of V8's cryptic rejection.
- Literal-writability decision recorded (fix or own todo).
