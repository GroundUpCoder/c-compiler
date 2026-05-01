/* Test: bitfield integer promotion in expressions
 * C99 6.3.1.1: bitfield values are promoted to int (or unsigned int)
 * when used in expressions, regardless of the declared width.
 */
#include <stdio.h>

struct S {
    unsigned int a : 3;  /* 0-7 */
    signed int b : 3;    /* -4 to 3 */
    unsigned int c : 1;  /* 0-1 */
};

int main() {
    struct S s;
    s.a = 7;
    s.b = -1;
    s.c = 1;

    /* Promotion: unsigned:3 with value 7 should promote to int */
    printf("a+1=%d\n", s.a + 1);           /* 8 (not wrapped to 0) */
    printf("-a=%d\n", -(int)s.a);           /* -7 */
    printf("a*2=%d\n", s.a * 2);           /* 14 */

    /* Signed bitfield promotion */
    printf("b=%d\n", s.b);                 /* -1 */
    printf("b+1=%d\n", s.b + 1);           /* 0 */
    printf("b*b=%d\n", s.b * s.b);         /* 1 */

    /* Promotion in shifts */
    printf("a<<1=%d\n", s.a << 1);         /* 14 */
    printf("c<<31=%d\n", s.c << 31);       /* -2147483648 or 0x80000000 */

    /* Promotion in division */
    printf("a/2=%d\n", s.a / 2);           /* 3 */
    printf("b/2=%d\n", s.b / 2);           /* 0 (truncates toward zero) */

    /* Bitfield in larger expression */
    int x = s.a + s.b + s.c;
    printf("a+b+c=%d\n", x);               /* 7 + (-1) + 1 = 7 */

    /* Unsigned promotion: should not sign-extend */
    unsigned int ua = s.a;
    printf("ua=%u\n", ua);                 /* 7 */

    /* Signed promotion: should sign-extend */
    int sb = s.b;
    printf("sb=%d\n", sb);                 /* -1 */

    return 0;
}
