// BUG: void-pointer arithmetic (GNU extension: sizeof(void)==1) silently
// compiled to +0 — `memcpy(d, s, n) + n` returned d, so busybox's
// mempcpy-based o_addblock wrote its NUL over the first copied byte and
// hush corrupted every expanded word. Found porting busybox hush
// (todos/0005).
// C11: 6.5.6 additive operators (constraint: complete object type) + the
// gcc/clang extension treating void as size 1 for pointer arithmetic.
// EXPECT: matches gcc/clang: void* +/- n moves by n bytes; void* difference
// counts bytes.
#include <stdio.h>
#include <string.h>

int main(void) {
    char d[16] = {0};
    void *p = memcpy(d, "echo", 4);
    void *q = p + 4;
    printf("delta: %d\n", (int)((char *)q - (char *)p));
    ((char *)(memcpy(d, "echo", 4) + 4))[0] = 'X';
    printf("buf: %.5s\n", d);
    void *r = q - 3;                       /* subtraction too */
    printf("back: %d\n", (int)((char *)r - d));
    printf("diff: %d\n", (int)(q - p));    /* void* difference: bytes */
    p += 2;                                /* compound assignment */
    printf("plus-eq: %d\n", (int)((char *)p - d));
    return 0;
}
