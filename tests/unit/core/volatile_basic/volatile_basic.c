/* Basic volatile variable tests */
#include <stdio.h>

volatile int g_vol;

int main(void) {
    g_vol = 0;
    g_vol++;
    g_vol++;
    g_vol++;
    if (g_vol != 3) { printf("FAIL: global volatile inc\n"); return 1; }

    volatile int local = 10;
    int snapshot = local;
    if (snapshot != 10) { printf("FAIL: local volatile read\n"); return 1; }

    local = 20;
    if (local != 20) { printf("FAIL: local volatile write\n"); return 1; }

    /* Volatile pointer */
    volatile int arr[3] = { 100, 200, 300 };
    if (arr[1] != 200) { printf("FAIL: volatile array\n"); return 1; }

    printf("PASS\n");
    return 0;
}
