/* Bug: unsigned int compared as signed when compared against signed long.
 * On wasm32, int and long are both 32-bit. Per C99 §6.3.1.8, when
 * unsigned int and signed long have the same rank/size, the signed
 * operand is converted to unsigned. So `(unsigned int)0x80000000 < 0L`
 * should be false (unsigned comparison), but the compiler does signed
 * comparison and treats 0x80000000 as negative.
 *
 * From GCC torture test: 20030316-1.c (PR target/9164)
 */
#include <stdio.h>

int main(void) {
    long j = 0x40000000;
    unsigned int u = (unsigned int)(0x40000000 + j);
    printf("u = %u\n", u);

    /* u = 0x80000000 (2147483648). This is NOT < 0 in unsigned comparison. */
    if (u < 0L) {
        printf("BUG\n");
        return 1;
    }

    /* Also test direct comparison */
    unsigned int v = 0x80000000U;
    if (v < 0L) {
        printf("BUG2\n");
        return 1;
    }

    printf("OK\n");
    return 0;
}
