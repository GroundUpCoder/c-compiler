#include <stdio.h>

int main(void) {
    printf("clz(1)=%d\n", __builtin_clz(1));
    printf("clz(256)=%d\n", __builtin_clz(256));
    printf("clz(0x80000000)=%d\n", __builtin_clz(0x80000000u));
    printf("ctz(1)=%d\n", __builtin_ctz(1));
    printf("ctz(8)=%d\n", __builtin_ctz(8));
    printf("ctz(0x80000000)=%d\n", __builtin_ctz(0x80000000u));
    printf("clzl(1)=%d\n", __builtin_clzl(1));
    printf("ctzl(8)=%d\n", __builtin_ctzl(8));
    printf("clzll(1)=%d\n", __builtin_clzll(1LL));
    printf("ctzll(8)=%d\n", __builtin_ctzll(8LL));
    return 0;
}
