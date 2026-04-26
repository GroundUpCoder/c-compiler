#include <stdio.h>

// C99 6.7.9p9: "unnamed members of objects of structure and union type
// do not participate in initialization"
//
// BUG: anonymous bitfields are included in normalizeInitList's varMembers
// but codegen skips them (without incrementing elemIdx), causing a
// misalignment between init-list elements and struct members.
struct S {
    int x;
    int : 16;   // anonymous bitfield — should be skipped during init
    int y;
};

int main() {
    // Positional init: anon bitfield should be skipped, so {1, 2} means x=1, y=2
    struct S s1 = {1, 2};
    printf("s1: x=%d y=%d\n", s1.x, s1.y);

    // Designated init: .y should target y directly
    struct S s2 = {.y = 99};
    printf("s2: x=%d y=%d\n", s2.x, s2.y);

    return 0;
}
