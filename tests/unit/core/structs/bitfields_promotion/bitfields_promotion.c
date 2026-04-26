#include <stdio.h>

/*
 * Test C99 6.3.1.1 integer promotion for bitfields:
 * "If an int can represent all values of the original type (as restricted
 *  by the width, for a bit-field), the value is converted to an int;
 *  otherwise, it is converted to an unsigned int."
 *
 * A 7-bit unsigned bitfield (range 0-127) fits in int, so it MUST promote
 * to signed int, not unsigned int. This affects the result of operations
 * like modulo where signedness matters.
 */

int main(void) {
    struct x { signed int i : 7; unsigned int u : 7; } bit;

    unsigned int u;
    int i;
    unsigned int unsigned_result = -13U % 61;
    int signed_result = -13 % 61;

    bit.u = 61, u = 61;
    bit.i = -13, i = -13;

    /* int % unsigned int -> unsigned result */
    if (i % u != unsigned_result) {
        printf("FAIL: i %% u != unsigned_result (%d vs %u)\n", i % u, unsigned_result);
        return 1;
    }

    /* int % (unsigned int)u -> unsigned result */
    if (i % (unsigned int)u != unsigned_result) {
        printf("FAIL: i %% (unsigned int)u != unsigned_result\n");
        return 1;
    }

    /* bit.u (7-bit unsigned) promotes to signed int, so int % int -> signed result */
    if (i % bit.u != signed_result) {
        printf("FAIL: i %% bit.u = %d, expected %d (signed_result)\n", i % bit.u, signed_result);
        return 1;
    }

    /* bit.i (7-bit signed) promotes to signed int, bit.u promotes to signed int */
    if (bit.i % bit.u != signed_result) {
        printf("FAIL: bit.i %% bit.u = %d, expected %d\n", bit.i % bit.u, signed_result);
        return 1;
    }

    /* Explicit cast to unsigned int overrides: unsigned % -> unsigned result */
    if (i % (unsigned int)bit.u != unsigned_result) {
        printf("FAIL: i %% (unsigned int)bit.u = %d, expected %u\n",
               i % (unsigned int)bit.u, unsigned_result);
        return 1;
    }

    if (bit.i % (unsigned int)bit.u != unsigned_result) {
        printf("FAIL: bit.i %% (unsigned int)bit.u = %d, expected %u\n",
               bit.i % (unsigned int)bit.u, unsigned_result);
        return 1;
    }

    printf("PASS\n");
    return 0;
}
