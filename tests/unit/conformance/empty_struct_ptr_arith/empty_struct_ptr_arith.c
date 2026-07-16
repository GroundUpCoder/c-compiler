// BUG: pointer arithmetic over arrays of EMPTY structs (GNU extension,
// sizeof == 0) used stride 1 — `&a[9] - &a[0]` yielded 9 and `p + n`
// moved by n bytes. The ptrArithElemSize clamp (void_ptr_arith / G1)
// clamped EVERY zero-size pointee to 1, but only void/function types are
// the GNU stride-1 extension; an empty struct is genuinely size 0:
// indexing lands on the same address and a pointer difference is 0.
// Bug-hunt G23 (todos/0227).
// C11: 6.5.6 additive operators + the GNU zero-size-struct extension.
// EXPECT: matches gcc/clang -O0 (clang's own folding of the zero-size
// difference is unstable across -O levels — gcc documents 0; every shape
// below is one clang reproduces stably).
#include <stdio.h>

struct E {};

int main(void) {
    struct E a[10];
    struct E *p = &a[0], *q = &a[9];
    printf("sizeof: %d\n", (int)sizeof(struct E));
    printf("diff: %d\n", (int)(q - p));
    printf("idx: %d\n", (int)((char *)&a[9] - (char *)&a[0]));
    p++;
    printf("inc: %d\n", (int)((char *)p - (char *)&a[0]));
    p += 5;
    printf("pluseq: %d\n", (int)((char *)p - (char *)&a[0]));
    printf("same: %d\n", &a[9] == &a[0]);
    return 0;
}
