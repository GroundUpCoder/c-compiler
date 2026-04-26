/* Bug: assignment to unsigned short doesn't truncate to 16 bits.
 *
 * `unsigned short us = (long long)-1;` should store 65535 (0xFFFF),
 * but the compiler stores 0xFFFFFFFF (4294967295) — the full 32-bit
 * representation. The unsigned short local is not being masked to
 * 16 bits on store.
 *
 * Also: global initializers for sub-int types (char, short) don't
 * truncate values. unsigned char global initialized with 0x1234U
 * stores 0x1234 instead of 0x34.
 *
 * From GCC torture tests: 960801-1.c, 20020226-1.c
 */
#include <stdio.h>

/* Global init truncation */
unsigned char g_uc = (unsigned char)0x1234U;
unsigned short g_us = (unsigned short)0x12345678U;

unsigned f(void) {
    long long l2;
    unsigned short us;
    unsigned long long ul;
    short s2;

    ul = us = l2 = s2 = -1;
    return ul;
}

int main(void) {
    /* Global init should truncate */
    printf("g_uc = 0x%x\n", (unsigned)g_uc);
    printf("g_us = 0x%x\n", (unsigned)g_us);
    if (g_uc != 0x34) return 1;
    if (g_us != 0x5678) return 1;

    /* Chain assignment should truncate at each step */
    unsigned result = f();
    printf("result = %u\n", result);
    if (result != 65535) return 1;

    /* Simple unsigned short assignment */
    unsigned short us = -1;
    unsigned int ui = us;
    printf("us via ui = %u\n", ui);
    if (ui != 65535) return 1;

    return 0;
}
