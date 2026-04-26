/* Test that integer constants in double array/struct init lists are
 * correctly converted to IEEE 754 representation.
 * Previously, `double a[2] = { 42, 23 }` wrote raw integer bytes
 * instead of double-encoded bytes into static data. */
#include <stdio.h>

struct S { double x; int y; };

int main(void) {
    /* Array init with int literals */
    double a[2] = { 42, 23 };
    printf("%f %f\n", a[0], a[1]);
    if (a[0] != 42.0 || a[1] != 23.0) return 1;

    /* Single element */
    double b[1] = { 7 };
    printf("%f\n", b[0]);
    if (b[0] != 7.0) return 1;

    /* Struct member */
    struct S s = { 99, 5 };
    printf("%f %d\n", s.x, s.y);
    if (s.x != 99.0 || s.y != 5) return 1;

    /* Mixed float and int */
    double c[3] = { 1.5, 2, 3 };
    printf("%f %f %f\n", c[0], c[1], c[2]);
    if (c[0] != 1.5 || c[1] != 2.0 || c[2] != 3.0) return 1;

    printf("OK\n");
    return 0;
}
