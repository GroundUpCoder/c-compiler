#include <stdio.h>

// C11 6.7.2.1p1: _Static_assert allowed inside struct/union declarations
struct Foo {
    int x;
    _Static_assert(sizeof(int) == 4, "int must be 4 bytes");
    double y;
    _Static_assert(sizeof(double) == 8, "double must be 8 bytes");
};

union Bar {
    int i;
    _Static_assert(1, "always true");
    float f;
};

int main(void) {
    struct Foo f;
    f.x = 10;
    f.y = 3.14;
    printf("%d %.2f\n", f.x, f.y);

    union Bar b;
    b.i = 42;
    printf("%d\n", b.i);
    return 0;
}
