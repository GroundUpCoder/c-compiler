// BUG: ++/-- on a void* compiled to a stride-0 add — the pointer never
// moved (pre/post, inc/dec all affected). p+1 and p+=1 already used the
// GNU stride-1 clamp (ptrArithElemSize), so mixed code silently walked
// wrong. Found in the 2026-07 fresh-eyes hunt (todos/0203).
// C11: 6.5.2.4/6.5.3.1 (constraint: complete object type) + the gcc/clang
// extension treating void as size 1 for pointer arithmetic.
// EXPECT: matches gcc/clang: void* ++/-- moves by exactly 1 byte.
#include <stdio.h>

int main(void) {
    char b[4] = {10, 20, 30, 40};
    void *q = b;
    q++;                                   /* post-increment */
    printf("post-inc: %d\n", *(char *)q);
    ++q;                                   /* pre-increment */
    printf("pre-inc: %d\n", *(char *)q);
    void *old = q--;                       /* post-dec: value is old q */
    printf("post-dec: %d %d\n", *(char *)q, *(char *)old);
    --q;                                   /* pre-decrement */
    printf("pre-dec: %d\n", *(char *)q);
    void *r = ++q;                         /* pre-inc value is new q */
    printf("pre-val: %d\n", *(char *)r);
    return 0;
}
