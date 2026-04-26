/* Test GCC cast-to-union extension: (union_type) expr
 * Initializes the union via the first member whose type matches. */
#include <stdio.h>

typedef union {
    unsigned long long d;
    struct { unsigned long l, h; } s;
} U;

void show(U u) {
    printf("d=%llu l=%lu h=%lu\n", u.d, (unsigned long)u.s.l, (unsigned long)u.s.h);
}

int main(void) {
    /* Basic cast to union via first matching member (d: unsigned long long) */
    U a = (U) 42ULL;
    if (a.d != 42) return 1;
    show(a);

    /* Large value that spans both struct halves */
    U b = (U) 0x100000000ULL;
    if (b.d != 0x100000000ULL) return 1;
    if (b.s.l != 0 || b.s.h != 1) return 1;
    show(b);

    /* As function argument */
    show((U) 99ULL);

    /* Cast to union with int member */
    union { int i; float f; } x = (union { int i; float f; }) 123;
    printf("i=%d\n", x.i);
    if (x.i != 123) return 1;

    printf("OK\n");
    return 0;
}
