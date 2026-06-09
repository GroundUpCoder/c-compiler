#include <stdio.h>

/* Regression test: a labeled statement used as the *bare* (non-block) body of
   an `if` must stay guarded by the condition. compiler.js dropped the guard,
   so the labeled statement ran unconditionally.

   Reduced from TCC 0.9.27's parse_define (tccpp.c):
       if (3 == spc)
   bad_twosharp:
       tcc_error("'##' cannot appear at either end of macro");
   which fired even when spc != 3. */

int guarded(int x) {
    int hit = 0;
    if (x == 3)
    lbl:                       /* labeled stmt is the bare if-body */
        hit = 1;
    if (x == 99) goto lbl;     /* keep lbl a live goto target */
    return hit;
}

int main(void) {
    printf("%d\n", guarded(0));   /* 0: condition false -> labeled stmt skipped */
    printf("%d\n", guarded(3));   /* 1: condition true  */
    printf("%d\n", guarded(7));   /* 0 */
    return 0;
}
