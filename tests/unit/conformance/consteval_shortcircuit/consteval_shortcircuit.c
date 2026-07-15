// BUG: constEvalItem evaluated BOTH operands of &&/|| (no short-circuit,
// though the ternary case was lazy) — `enum { C1 = 1 || 1/0 }` failed the
// eval and silently fell back to the running enum counter (C1 == 0), and
// valid `case (1 || 1/0)+1:` / `int a[1 || 1/0];` were rejected. Found in
// the 2026-07 fresh-eyes hunt (todos/0207).
// C11: 6.6p3 — operands of && / || that are not evaluated do not
// participate in the constant expression's constraints (via 6.5.13p4 /
// 6.5.14p4 guaranteed non-evaluation).
// EXPECT: matches gcc/clang.
#include <stdio.h>

enum { C1 = 1 || 1/0, C3 = 0 && 1/0, C4 = C1 + 1 };
int a[1 || 1/0];

int main(void) {
    switch (2) {
      case (1 || 1/0) + 1: printf("case ok\n"); break;
      default: printf("default\n"); break;
    }
    printf("%d %d %d %d\n", C1, C3, C4, (int)(sizeof a / sizeof a[0]));
    return 0;
}
