#include <stdio.h>
#include <stdlib.h>

int main(void) {
    /* basic 64-bit clz */
    printf("%d\n", __builtin_clzll(1ULL));           /* 63 */
    printf("%d\n", __builtin_clzll(1ULL << 32));     /* 31 */
    printf("%d\n", __builtin_clzll(1ULL << 63));     /* 0 */
    printf("%d\n", __builtin_clzll(0xFFFFFFFFFFFFFFFFULL)); /* 0 */
    printf("%d\n", __builtin_clzll(0x00000001FFFFFFFFULL)); /* 31 */
    printf("%d\n", __builtin_clzll(256ULL));          /* 55 */

    /* basic 64-bit ctz */
    printf("%d\n", __builtin_ctzll(1ULL));           /* 0 */
    printf("%d\n", __builtin_ctzll(1ULL << 32));     /* 32 */
    printf("%d\n", __builtin_ctzll(1ULL << 63));     /* 63 */
    printf("%d\n", __builtin_ctzll(0x8000000000000000ULL)); /* 63 */
    printf("%d\n", __builtin_ctzll(256ULL));          /* 8 */

    /* 32-bit versions still work */
    printf("%d\n", __builtin_clz(1));                /* 31 */
    printf("%d\n", __builtin_ctz(1));                /* 0 */

    return 0;
}
