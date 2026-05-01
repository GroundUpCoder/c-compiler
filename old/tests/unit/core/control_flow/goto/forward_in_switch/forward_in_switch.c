/* Test: forward goto labels inside switch body.
 *
 * Pattern from FreeType's ft_glyphslot_preset_bitmap:
 * Multiple cases goto a label (Adjust:) that appears in a later
 * case within the same switch body.
 */

#include <stdio.h>

int compute(int mode, int base) {
    int result;

    switch (mode) {
    case 0:
        result = base * 2;
        break;

    case 1:
        result = base + 10;
        goto Adjust;

    case 2:
        result = base + 20;
        goto Adjust;

    case 3:
    default:
        result = base;
    Adjust:
        result += 100;
    }

    return result;
}

int main(void) {
    printf("%d\n", compute(0, 5));   /* 10 — case 0: 5*2, break */
    printf("%d\n", compute(1, 5));   /* 115 — case 1: 5+10=15, goto Adjust, +100 */
    printf("%d\n", compute(2, 5));   /* 125 — case 2: 5+20=25, goto Adjust, +100 */
    printf("%d\n", compute(3, 5));   /* 105 — case 3/default: 5, fall-through to Adjust, +100 */
    printf("%d\n", compute(99, 5));  /* 105 — default: 5, fall-through to Adjust, +100 */
    return 0;
}
