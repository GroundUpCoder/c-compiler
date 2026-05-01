/* Test: modifying one bitfield must not corrupt adjacent fields
 * This tests the read-modify-write correctness of bitfield stores.
 * Each store must only affect its own bits.
 */
#include <stdio.h>

struct Packed {
    unsigned int a : 4;  /* bits 0-3 */
    unsigned int b : 4;  /* bits 4-7 */
    unsigned int c : 4;  /* bits 8-11 */
    unsigned int d : 4;  /* bits 12-15 */
    unsigned int e : 4;  /* bits 16-19 */
    unsigned int f : 4;  /* bits 20-23 */
    unsigned int g : 4;  /* bits 24-27 */
    unsigned int h : 4;  /* bits 28-31 */
};

int main() {
    struct Packed p;

    /* Initialize all fields */
    p.a = 1; p.b = 2; p.c = 3; p.d = 4;
    p.e = 5; p.f = 6; p.g = 7; p.h = 8;

    printf("init: %d %d %d %d %d %d %d %d\n",
           p.a, p.b, p.c, p.d, p.e, p.f, p.g, p.h);

    /* Modify middle field, check others unchanged */
    p.d = 15;
    printf("mod d: %d %d %d %d %d %d %d %d\n",
           p.a, p.b, p.c, p.d, p.e, p.f, p.g, p.h);

    /* Modify first field */
    p.a = 0;
    printf("mod a: %d %d %d %d %d %d %d %d\n",
           p.a, p.b, p.c, p.d, p.e, p.f, p.g, p.h);

    /* Modify last field */
    p.h = 0;
    printf("mod h: %d %d %d %d %d %d %d %d\n",
           p.a, p.b, p.c, p.d, p.e, p.f, p.g, p.h);

    /* Modify two adjacent fields in sequence */
    p.b = 15;
    p.c = 15;
    printf("mod bc: %d %d %d %d %d %d %d %d\n",
           p.a, p.b, p.c, p.d, p.e, p.f, p.g, p.h);

    /* Set all to max, then clear one by one */
    p.a = 15; p.b = 15; p.c = 15; p.d = 15;
    p.e = 15; p.f = 15; p.g = 15; p.h = 15;
    printf("all 15: %d %d %d %d %d %d %d %d\n",
           p.a, p.b, p.c, p.d, p.e, p.f, p.g, p.h);

    p.a = 0;
    printf("clr a: %d %d %d %d %d %d %d %d\n",
           p.a, p.b, p.c, p.d, p.e, p.f, p.g, p.h);
    p.d = 0;
    printf("clr d: %d %d %d %d %d %d %d %d\n",
           p.a, p.b, p.c, p.d, p.e, p.f, p.g, p.h);
    p.h = 0;
    printf("clr h: %d %d %d %d %d %d %d %d\n",
           p.a, p.b, p.c, p.d, p.e, p.f, p.g, p.h);

    /* Mix of signed and unsigned adjacent fields */
    struct Mixed {
        signed int s : 4;    /* -8 to 7 */
        unsigned int u : 4;  /* 0 to 15 */
    } m;

    m.s = -1;
    m.u = 15;
    printf("mixed: s=%d u=%d\n", m.s, m.u);

    m.s = -8;
    printf("mixed mod s: s=%d u=%d\n", m.s, m.u);

    m.u = 0;
    printf("mixed mod u: s=%d u=%d\n", m.s, m.u);

    return 0;
}
