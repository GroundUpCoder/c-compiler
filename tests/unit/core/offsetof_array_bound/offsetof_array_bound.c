#include <stdio.h>
#include <stddef.h>

/* 0087 triage item-1 regression lock: an offsetof DIFFERENCE is an integer
 * constant expression, so it is valid as an array bound and must NOT be
 * mis-parsed as a VLA (the bug once rejected this). If the ICE were rejected
 * the file would fail to compile; if the bound were treated as non-constant
 * sizeof(buf) would not fold. Both lines print the same value by construction,
 * proving the bound folded to the offsetof difference at compile time. */
typedef struct {
    char   a;
    int    b;
    char   c[10];
    double d;
} T;

static unsigned char buf[offsetof(T, c) - offsetof(T, b)];

int main(void) {
    printf("%d\n", (int)(offsetof(T, c) - offsetof(T, b)));
    printf("%d\n", (int)sizeof(buf));
    return 0;
}
