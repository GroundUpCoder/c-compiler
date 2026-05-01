// Designated init: non-first member of anonymous union (global)
// Same root cause as the local variant, but globals don't crash --
// they silently produce wrong values because ConstEval short-circuits
// on the misplaced null Expr and the static data stays zero.
#include <stdio.h>

struct S {
    union { int a; float b; };
    int c;
};

// First member works correctly (index 0 == default unionMemberIndex)
struct S g1 = { .a = 42, .c = 10 };
// Non-first member: value is lost, reads back as 0
struct S g2 = { .b = 3.14f, .c = 20 };

int main() {
    printf("g1: %d %d\n", g1.a, g1.c);
    printf("g2: %.2f %d\n", (double)g2.b, g2.c);
    return 0;
}
