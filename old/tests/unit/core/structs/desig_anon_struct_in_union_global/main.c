// Designated init: anonymous struct as non-first member of anonymous union (global)
// Same chain-processing bug. For globals the compiler doesn't crash,
// but the values are silently lost (written to wrong init-list slots
// that codegen never reads).
#include <stdio.h>

struct S {
    union {
        int val;
        struct { int x, y; };
    };
    int z;
};

struct S g = { .x = 10, .y = 20, .z = 30 };

int main() {
    printf("%d %d %d\n", g.x, g.y, g.z);
    return 0;
}
