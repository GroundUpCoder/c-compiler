/* Test: increment and decrement operators on bitfields
 * Tests pre/post increment/decrement, which involve both
 * load and store of the bitfield (read-modify-write).
 */
#include <stdio.h>

struct S {
    unsigned int a : 4;  /* 0-15 */
    signed int b : 4;    /* -8 to 7 */
    unsigned int c : 1;  /* 0-1 */
};

int main() {
    struct S s;

    /* Post-increment: returns old value, stores new */
    s.a = 5;
    int r = s.a++;
    printf("post++: ret=%d new=%d\n", r, s.a);  /* ret=5 new=6 */

    /* Pre-increment: returns new value */
    s.a = 5;
    r = ++s.a;
    printf("pre++: ret=%d val=%d\n", r, s.a);   /* ret=6 val=6 */

    /* Post-decrement */
    s.a = 5;
    r = s.a--;
    printf("post--: ret=%d new=%d\n", r, s.a);  /* ret=5 new=4 */

    /* Pre-decrement */
    s.a = 5;
    r = --s.a;
    printf("pre--: ret=%d val=%d\n", r, s.a);   /* ret=4 val=4 */

    /* Increment with truncation */
    s.a = 15;
    s.a++;
    printf("15++: %d\n", s.a);  /* 0 (wraps) */

    /* Decrement with underflow */
    s.a = 0;
    s.a--;
    printf("0--: %d\n", s.a);   /* 15 (wraps unsigned) */

    /* Signed increment at boundary */
    s.b = 7;  /* max for 4-bit signed */
    s.b++;
    printf("s7++: %d\n", s.b);  /* -8 (wraps) */

    s.b = -8;  /* min for 4-bit signed */
    s.b--;
    printf("s-8--: %d\n", s.b); /* 7 (wraps) */

    /* 1-bit unsigned increment */
    s.c = 0;
    s.c++;
    printf("c0++: %d\n", s.c);  /* 1 */
    s.c++;
    printf("c1++: %d\n", s.c);  /* 0 (wraps) */

    /* Increment in loop */
    s.a = 0;
    int sum = 0;
    while (s.a < 10) {
        sum += s.a;
        s.a++;
    }
    printf("loop sum=%d final_a=%d\n", sum, s.a);  /* sum=45 final_a=10 */

    /* Pre-increment as condition */
    s.a = 13;
    if (++s.a == 14) {
        printf("preinc cond: ok\n");
    }

    /* Post-increment preserves other fields */
    s.a = 5;
    s.b = -3;
    s.c = 1;
    s.a++;
    printf("after a++: a=%d b=%d c=%d\n", s.a, s.b, s.c);

    s.b++;
    printf("after b++: a=%d b=%d c=%d\n", s.a, s.b, s.c);

    return 0;
}
