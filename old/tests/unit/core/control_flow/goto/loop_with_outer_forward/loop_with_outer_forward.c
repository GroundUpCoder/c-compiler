/* Test: loop label with forward gotos to labels in enclosing scope.
 *
 * Pattern from FreeType's FT_Outline_Decompose:
 * A backward goto (loop) inside an inner block, with forward gotos
 * jumping to labels in an outer scope. The forward labels are in a
 * different compound block than the loop label, so they should NOT
 * close the loop label's scope.
 */

#include <stdio.h>

int decompose(int *points, int n) {
    int i = 0;
    int sum = 0;

    while (i < n) {
        int val = points[i];
        switch (val) {
        case 0:
            /* forward goto to outer label */
            goto done;

        case 1:
            /* simple case, continue outer loop */
            sum += val;
            i++;
            continue;

        default:
            /* inner loop via backward goto */
        process:
            sum += points[i];
            i++;
            if (i < n && points[i] >= 10) {
                /* forward goto to outer label from inside loop */
                if (points[i] == 99)
                    goto error;
                goto process; /* backward goto — the loop */
            }
            continue;
        }
    }

done:
    return sum;

error:
    return -1;
}

int main(void) {
    int a[] = {1, 1, 1, 0};
    printf("%d\n", decompose(a, 4));      /* 3 — three 1s then stop */

    int b[] = {10, 11, 12, 0};
    printf("%d\n", decompose(b, 4));      /* 33 — loop processes 10+11+12 */

    int c[] = {10, 99};
    printf("%d\n", decompose(c, 2));      /* -1 — error exit */

    int d[] = {1, 10, 11, 1, 0};
    printf("%d\n", decompose(d, 5));      /* 23 — 1 + (10+11) + 1 */

    return 0;
}
