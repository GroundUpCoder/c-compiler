/* Test: array-to-pointer decay with -> operator.
 * An array of structs used with -> should decay to a pointer to the first
 * element, so arr->field is equivalent to arr[0].field.
 */

#include <stdio.h>

struct Point {
    int x;
    int y;
};

struct Point points[3] = {{10, 20}, {30, 40}, {50, 60}};

int main() {
    /* arr -> decays to &arr[0], so points->x == points[0].x */
    printf("%d %d\n", points->x, points->y);
    printf("%d %d\n", (points + 1)->x, (points + 1)->y);
    printf("%d %d\n", (points + 2)->x, (points + 2)->y);
    return 0;
}
