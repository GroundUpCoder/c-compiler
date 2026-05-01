// Designated init: non-first member of anonymous union (local)
// Bug: normalizeInitList's anonymous member chain (findMemberChain path)
// doesn't set unionMemberIndex when an intermediate type is a union.
// It sets index=j (the member's position), but for unions index must
// stay 0 and unionMemberIndex should be set instead.
// Result: compiler crashes on local variables (null Expr in emitExpr).
#include <stdio.h>

struct S {
    union { int a; float b; };
    int c;
};

int main() {
    // .b is the second member of the anonymous union
    struct S s = { .b = 1.5f, .c = 10 };
    printf("%.1f %d\n", (double)s.b, s.c);

    // Also test with 3 union members, designating the third
    struct S2 {
        union { int x; float y; double z; };
        int w;
    };
    struct S2 s2 = { .z = 9.99, .w = 7 };
    printf("%.2f %d\n", s2.z, s2.w);

    return 0;
}
