// Assigning an out-of-range value into a 64-bit bit-field truncates
// (keeps the low N bits).
#include <stdio.h>

struct S {
    unsigned long long u33 : 33;
    long long s33 : 33;
    unsigned long long u52 : 52;
};

int main(void) {
    struct S s;
    s.u33 = 0xFFFFFFFFFFFFFFFFull;       // all 64 bits set
    printf("u33_trunc=0x%llx\n", (unsigned long long)s.u33);  // expect 0x1FFFFFFFF

    s.u52 = 0xFFFFFFFFFFFFFFFFull;
    printf("u52_trunc=0x%llx\n", (unsigned long long)s.u52);  // expect 0xFFFFFFFFFFFFF

    // Signed 33-bit: 0xFFFFFFFFFFFFFFFF -> bit pattern 0x1FFFFFFFF as 33-bit
    // signed = -1 (since top bit set in 33-bit window).
    s.s33 = 0xFFFFFFFFFFFFFFFFull;
    printf("s33_trunc=%lld\n", (long long)s.s33);             // expect -1

    // Truncation of a positive constant just larger than 33 bits.
    // 0x300000000 = 0b11 << 32; in 33-bit window, bit 32 = 1, bits 0..31 = 0
    // → signed value = -2^32 = -4294967296.
    s.s33 = 0x300000000LL;
    printf("s33_sign=%lld\n", (long long)s.s33);              // expect -4294967296
    return 0;
}
