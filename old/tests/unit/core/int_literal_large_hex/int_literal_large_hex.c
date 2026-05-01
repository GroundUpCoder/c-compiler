#include <stdio.h>

/* Test that large hex literals with u suffix get correct type/value.
 * 0xffffffffffffffffu is unsigned long long (doesn't fit in unsigned int).
 * When used in i32 context (e.g., & with uint), should truncate properly.
 */

typedef unsigned long long ULL;

#define trim64(x) ((x) & 0xffffffffffffffffu)
#define trim32(x) ((x) & 0xffffffffu)

ULL test_trim64(ULL x) {
    return trim64(x);
}

ULL test_trim32(ULL x) {
    return trim32(x);
}

int main(void) {
    ULL x = 0x123456789ABCDEFull;
    printf("trim64: %llu\n", test_trim64(x));
    printf("trim32: %llu\n", test_trim32(x));

    /* Test the mask values directly */
    ULL mask64 = 0xffffffffffffffffu;
    unsigned int mask32 = 0xffffffffu;
    printf("mask64: %llu\n", mask64);
    printf("mask32: %u\n", mask32);

    return 0;
}
