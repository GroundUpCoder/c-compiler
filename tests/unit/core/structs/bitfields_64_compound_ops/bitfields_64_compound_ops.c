// Compound assignment on 64-bit bit-fields.
#include <stdio.h>

struct S {
    unsigned long long a : 40;
    unsigned long long b : 24;
};

int main(void) {
    struct S s;
    s.a = 100; s.b = 0;
    s.a += 0x1000000000ull;        // adds 2^36
    printf("after_add: a=0x%llx b=%llu\n",
           (unsigned long long)s.a, (unsigned long long)s.b);

    s.a = 0;
    s.a |= 0xAAAAAAAAAAull;
    s.a |= 0x5555555555ull;
    printf("after_or: a=0x%llx\n", (unsigned long long)s.a);

    s.a = 0xFFFFFFFFFFull;
    s.a &= 0x0F0F0F0F0Full;
    printf("after_and: a=0x%llx\n", (unsigned long long)s.a);

    s.a = 1;
    s.a <<= 35;
    printf("after_shl: a=0x%llx\n", (unsigned long long)s.a);

    s.a = 0xFFFFFFFFFFull;
    s.a >>= 8;
    printf("after_shr: a=0x%llx\n", (unsigned long long)s.a);

    s.a = 100;
    s.b = 7;
    s.a *= 3;
    s.b *= 11;
    printf("after_mul: a=%llu b=%llu\n", (unsigned long long)s.a, (unsigned long long)s.b);

    // Pre/post increment
    s.b = 5;
    s.b++;
    ++s.b;
    printf("after_increments: b=%llu\n", (unsigned long long)s.b);
    return 0;
}
