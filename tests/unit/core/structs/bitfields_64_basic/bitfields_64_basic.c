// Basic 64-bit unsigned bit-field functionality:
// declare, assign, read back, multiple fields in same storage unit.
#include <stdio.h>

struct S {
    unsigned long long a : 33;
    unsigned long long b : 17;
    unsigned long long c : 5;
};

int main(void) {
    struct S s;
    s.a = 0x1ABCDEF12ull;     // 33 bits
    s.b = 0x1ABCDu & 0x1FFFFu; // 17 bits
    s.c = 0x1Du & 0x1Fu;       // 5 bits

    printf("a = %llu\n", (unsigned long long)s.a);
    printf("b = %llu\n", (unsigned long long)s.b);
    printf("c = %llu\n", (unsigned long long)s.c);

    // Largest 33-bit value
    s.a = 0x1FFFFFFFFull;  // 2^33 - 1
    printf("a_max = %llu\n", (unsigned long long)s.a);

    // Modify one field, verify others unchanged
    s.a = 100;
    s.b = 200;
    s.c = 7;
    s.a = 999;  // change only a
    printf("after a=999: a=%llu b=%llu c=%llu\n",
           (unsigned long long)s.a, (unsigned long long)s.b, (unsigned long long)s.c);
    return 0;
}
