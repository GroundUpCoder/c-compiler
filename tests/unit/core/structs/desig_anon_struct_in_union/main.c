// Designated init: anonymous struct as non-first member of anonymous union (local)
// The findMemberChain returns a chain through the anonymous union then
// the anonymous struct. The chain-processing loop sets index=j on the
// union level (j>0 for non-first member) instead of setting
// unionMemberIndex. This causes childType to resolve the wrong member
// type and the value is placed at the wrong slot, leading to a crash
// when emitExpr encounters the null Expr at elements[0].
#include <stdio.h>

struct S {
    union {
        int val;
        struct { int x, y; };
    };
    int z;
};

int main() {
    struct S s = { .x = 10, .y = 20, .z = 30 };
    printf("%d %d %d\n", s.x, s.y, s.z);
    return 0;
}
