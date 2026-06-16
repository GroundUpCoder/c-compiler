#include <stdio.h>

/* C11 6.7.9p14: an array of character type may be initialized by a string
   literal, optionally enclosed in braces. Regression: `{ "..." }` used to be
   treated as a single scalar element, producing a size-1 array with garbage
   contents (it broke musl's regerror message table). */

const char G[]        = { "hello" };       /* file-scope */
static const char ST[] = { "foo" "bar" };  /* adjacent-literal concatenation */
const char NUL[]      = { "x\0y" };        /* embedded NUL preserved */
const char SIZED[8]   = { "hi" };          /* sized array, zero-padded */

int main(void) {
    static const char S[] = { "world" };   /* static local */
    char A[]              = { "auto" };     /* automatic local */

    printf("G=%s sz=%d\n", G, (int)sizeof G);
    printf("ST=%s sz=%d\n", ST, (int)sizeof ST);
    printf("NUL=%s c2=%c sz=%d\n", NUL, NUL[2], (int)sizeof NUL);
    printf("SIZED=%s sz=%d last=%d\n", SIZED, (int)sizeof SIZED, SIZED[7]);
    printf("S=%s sz=%d\n", S, (int)sizeof S);
    printf("A=%s sz=%d\n", A, (int)sizeof A);
    return 0;
}
