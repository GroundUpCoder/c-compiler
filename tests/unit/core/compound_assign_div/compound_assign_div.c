/* Bug: compound assignment x /= y does not properly apply integer
 * promotions and truncation.
 *
 * Per C99 §6.5.16.2: "E1 op= E2" is equivalent to "E1 = E1 op E2"
 * except E1 is evaluated only once, and the result is converted to
 * the type of E1.
 *
 * So `unsigned char x = 50; x /= (short)-5;` should:
 *   1. Promote both to int: 50 / -5 = -10
 *   2. Convert -10 to unsigned char: 246
 *
 * But the compiler produces 0.
 *
 * From GCC torture test: 20030128-1.c
 */
#include <stdio.h>

int main(void) {
    unsigned char x = 50;
    volatile short y = -5;
    x /= y;
    printf("x = %u\n", (unsigned)x);
    if (x != 246) {
        return 1;
    }
    return 0;
}
