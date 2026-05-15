// Width-64 bit-field (the whole storage unit). No mask/shift needed
// at runtime — same as a normal u64 store/load. Make sure the codegen
// doesn't try to compute (1<<64)-1 (UB in C) or sign-extend a 64-bit
// value by 0 bits.
#include <stdio.h>

struct U { unsigned long long x : 64; };
struct S { signed long long y : 64; };

int main(void) {
    printf("sizeof_U=%d sizeof_S=%d\n",
           (int)sizeof(struct U), (int)sizeof(struct S));

    struct U u;
    u.x = 0xDEADBEEFCAFEBABEull;
    printf("u.x = 0x%llx\n", (unsigned long long)u.x);
    u.x = 0xFFFFFFFFFFFFFFFFull;
    printf("u.x_max = 0x%llx\n", (unsigned long long)u.x);
    u.x = 0;
    printf("u.x_zero = 0x%llx\n", (unsigned long long)u.x);

    struct S s;
    s.y = -1;
    printf("s.y_neg = %lld\n", (long long)s.y);
    s.y = 0x7FFFFFFFFFFFFFFFLL;
    printf("s.y_max = %lld\n", (long long)s.y);
    s.y = (long long)0x8000000000000000ULL;  // INT64_MIN bit pattern
    printf("s.y_min = %lld\n", (long long)s.y);
    return 0;
}
