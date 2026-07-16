# 0227 — bug-hunt close-out: G21/G22/G23/W2 (this COMPLETES the G1–G23 + W1/W2 agenda)

Landed as a two-executor handoff: the prior thread committed G21
(sizeof(void)/sizeof(fn) == 1 GNU, sizeof(incomplete) errors), G23
(empty-struct pointer arithmetic at genuine stride 0) and W2 (WAST
one-else-per-if in builder + validate) — all three adopted verbatim, not
redone — and left G22 (the seven-diagnostic accepts-invalid batch)
uncommitted, blocked on a csmith-corpus regression. This session verified,
finished, and landed G22 in three chunks (pp / sema / parser). clang was
the oracle throughout.

## The corpus regression and its fix (why G22 was stuck)

The naive const-assignment check rejected shapes the fuzz corpus (and
clang) consider legal — most importantly **writing a non-const member of a
struct that merely CONTAINS a const member elsewhere**, which csmith emits
constantly. The corpus-safe design (found already written in the
uncommitted tree by an earlier takeover attempt; verified here, kept):

- `constWriteViolation(type)` — C11 6.3.2.1p1's aggregate rule applies to
  the ASSIGNED TYPE itself: whole-aggregate assignment onto a struct/union
  with a const member (recursively, through nested aggregates and array
  elements) is rejected; a pointer-to-const member does NOT poison the
  aggregate (the pointer itself is writable) — the walk stops at pointers.
- `basePathConstViolation(expr)` — 6.5.2.3p3 qualifier propagation over
  the access path (`const struct P cp; cp.x = ..`, `pp->x` through a
  pointer-to-const struct) checks ONLY qualifier flow, never the
  const-member rule, so `s.n = 5` on a const-member-bearing `s` stays
  legal. A dereference stops the walk.

Two under-rejects found here by a 22-case clang differential and fixed:

1. `const struct A ca; ca.a[0] = 5` (array member of const struct) —
   makeSubscript wraps the array base in an `EDecay`, so the ESubscript
   branch of the base walk saw a pointer-typed node and went blind. Fix:
   look through `EDecay` (its inner is `.operand`, not `.expr` — the first
   attempt crashed sema on every subscript write and the differential
   caught it immediately).
2. `typedef int A[2]; const A ta; ta[0] = 5` — the const lands on the
   array TypeInfo, not the element. Fix: makeSubscript pushes const down
   to the element type, mirroring 0187's volatile push-down.

Final oracle: 22/22 MATCH vs clang (plus 2-D member arrays, const array
parameters, cast-away-const, `*(int*const)` write-through — all agree).

## The seven G22 diagnostics (all previously silent accepts)

| # | Construct | Before | After (clang-matching) |
|---|-----------|--------|------------------------|
| 1 | write to const lvalue (=, +=, ++/--) | compiled as a plain write | error, incl. member/path/aggregate cases above |
| 2 | `int a[-1]` | negative-size type, broken sizeof/layout | 6.7.6.2p1 error (explicit `[0]` stays — GNU zero-length) |
| 3 | `f(void x)` / `g(void, int)` | 0-size param, calls miscompiled | 6.7.6.3p10 error; `f(void)` + typedef'd sole void stay zero-param |
| 4 | `a ## ++` invalid paste | took FIRST lexed token, DROPPED the rest | 6.10.3.3p3 "pasting formed ..." (+ `##` at list ends errors) |
| 5 | trailing `#` in function-like macro body | expanded literal `#` | 6.10.3.2p1 error; object-like `#define HASH #` stays legal |
| 6 | `extern int y; static int y=4;` | silent linkage conflict | 6.2.2p7 error; legal static-then-extern (p4, G12/0219) untouched |
| 7 | `#frobnicate` | silently ignored | 6.10p1 error in ACTIVE groups only; skipped groups (6.10p6), GNU line markers, null directive pinned green |

Tests: 7 `diag_*` conformance dirs (exitcode-only) + the green companion
`pp_unknown_directive_skipped` pinning what must STAY accepted.

## Gating (front-end only — no codegen moved)

- `node tests/run.js unit ast`: 756 passed / 0 failed / 8 xfailed
  (count preserved) + ast 4/4.
- Fuzz corpus explicitly (the tripwire): **105/105** — all 100 vendored
  csmith programs + 5 live seeds differential vs clang, zero failures.
- SameBoy interlock once at the end: HEAD compiler.js vs the G22 diff over
  the full core build — **byte-identical** (252,938 bytes, same SHA-256),
  proving zero codegen movement.
- No mkimage bake / kernel suite / browser sweep: nothing outside the
  front-end moved, and the interlock proves it. No image version bump.

## Close-out

G22 landed as three commits (pp diagnostics / const-assignment sema /
parser diagnostics), pushed together with the adopted G21/G23/W2. This
closes todos/0227 and **completes the 2026-07 fresh-eyes bug-hunt agenda:
G1–G23 + W1/W2 all landed** (G1–G7+W1 via 0203–0209, G8–G20 via
0216–0225, the final four here). Deferred remainder: todos/0228
(read-only string literals — literals are deduplicated AND writable)
stays open by design.
