// BUG: enum constants in (INT_MAX, UINT_MAX] silently wrapped to negative
// int, flipping bit-31 flag enums (BIG > 0 was false).
// C11: 6.7.2.2p2 + the gcc/clang extension this project follows: such
// values get type unsigned int and keep their positive value.
// EXPECT: matches gcc/clang: BIG stays positive, comparisons unsigned.
#include <stdio.h>
enum { BIG = 0x80000000, ALLBITS = 0xFFFFFFFFu };
int main(void) {
    printf("%d\n", BIG > 0);
    printf("%lld\n", (long long)BIG);
    printf("%u\n", (unsigned)ALLBITS);
    printf("%d\n", ALLBITS > 100u);
    return 0;
}
