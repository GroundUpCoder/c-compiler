#include <strings.h>
#include <stdio.h>

int main(void) {
    // ffs: find first (least significant) set bit, 1-indexed, 0 if none
    printf("ffs(0) = %d\n", ffs(0));
    printf("ffs(1) = %d\n", ffs(1));
    printf("ffs(2) = %d\n", ffs(2));
    printf("ffs(3) = %d\n", ffs(3));
    printf("ffs(4) = %d\n", ffs(4));
    printf("ffs(0x80) = %d\n", ffs(0x80));
    printf("ffs(0x80000000) = %d\n", ffs((int)0x80000000));
    printf("ffs(-1) = %d\n", ffs(-1));

    // fls: find last (most significant) set bit, 1-indexed, 0 if none
    printf("fls(0) = %d\n", fls(0));
    printf("fls(1) = %d\n", fls(1));
    printf("fls(2) = %d\n", fls(2));
    printf("fls(3) = %d\n", fls(3));
    printf("fls(4) = %d\n", fls(4));
    printf("fls(0x80) = %d\n", fls(0x80));
    printf("fls(0x80000000) = %d\n", fls((int)0x80000000));
    printf("fls(-1) = %d\n", fls(-1));

    // ffsll/flsll: 64-bit variants
    printf("ffsll(0) = %d\n", ffsll(0));
    printf("ffsll(1) = %d\n", ffsll(1));
    printf("ffsll(0x100000000LL) = %d\n", ffsll(0x100000000LL));
    printf("flsll(0) = %d\n", flsll(0));
    printf("flsll(1) = %d\n", flsll(1));
    printf("flsll(0x100000000LL) = %d\n", flsll(0x100000000LL));

    return 0;
}
