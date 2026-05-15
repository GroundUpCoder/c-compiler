// Signed 64-bit bit-fields: sign-extension on read.
#include <stdio.h>

struct S {
    long long x : 33;   // range: -2^32 to 2^32-1
    long long y : 50;
    long long z : 64;   // full width — no truncation
};

int main(void) {
    struct S s;
    s.x = -1;
    s.y = -1;
    s.z = -1;
    printf("all-minus-one: x=%lld y=%lld z=%lld\n",
           (long long)s.x, (long long)s.y, (long long)s.z);

    s.x =  0xFFFFFFFFLL;        // 33-bit max positive (sign bit clear): 2^32 - 1
    s.y =  0x1FFFFFFFFFFFFLL;   // 50-bit max positive: 2^49 - 1
    printf("max-positive: x=%lld y=%lld\n", (long long)s.x, (long long)s.y);

    s.x = -0x100000000LL;       // 33-bit min negative: -2^32
    s.y = -0x2000000000000LL;   // 50-bit min negative: -2^49
    printf("min-negative: x=%lld y=%lld\n", (long long)s.x, (long long)s.y);

    // Cross-zero
    s.x = 0;
    s.y = -1;
    printf("zero-and-neg-one: x=%lld y=%lld\n", (long long)s.x, (long long)s.y);

    return 0;
}
