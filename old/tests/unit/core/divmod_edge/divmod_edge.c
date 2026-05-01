/* Division edge cases: MIN / -1 for small types (promoted to int, no overflow) */
#include <stdio.h>

int div_schar(signed char x, signed char y) { return x / y; }
int mod_schar(signed char x, signed char y) { return x % y; }
int div_short(short x, short y) { return x / y; }
int mod_short(short x, short y) { return x % y; }

int main(void) {
    if (div_schar(-128, -1) != 128) { printf("FAIL: schar -128/-1\n"); return 1; }
    if (mod_schar(-128, -1) != 0) { printf("FAIL: schar -128%%-1\n"); return 1; }
    if (div_short(-32768, -1) != 32768) { printf("FAIL: short -32768/-1\n"); return 1; }
    if (mod_short(-32768, -1) != 0) { printf("FAIL: short -32768%%-1\n"); return 1; }
    if (7 / 2 != 3) { printf("FAIL: 7/2\n"); return 1; }
    if (7 % 2 != 1) { printf("FAIL: 7%%2\n"); return 1; }
    if (-7 / 2 != -3) { printf("FAIL: -7/2\n"); return 1; }
    if (-7 % 2 != -1) { printf("FAIL: -7%%2\n"); return 1; }
    printf("PASS\n");
    return 0;
}
