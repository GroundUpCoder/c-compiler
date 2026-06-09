#include <stdio.h>

/* Regression test for "Cannot take address of REGISTER variable".

   A file-scope global whose address is taken ONLY before a later tentative
   re-declaration of the same global. The redeclaration becomes the
   definition; the address-taken -> MEMORY promotion must propagate to it,
   or codegen of `&g_counter` fails (the global gets allocated as an
   addressless wasm global).

   This mirrors TCC's `define_stack`: declared in a header, `&`-used in
   tccpp.c, re-declared in tccgen.c. The re-declaration must inherit the
   MEMORY allocation class from the address-taken earlier declaration. */

static int g_counter;

static void bump(int *p) { *p += 5; }          /* writes through the pointer */

static void use(void) { bump(&g_counter); }    /* the ONLY address-taken site */

static int g_counter;                          /* tentative redecl AFTER &-use */

int main(void) {
    use();                       /* g_counter += 5 via pointer alias */
    use();                       /* += 5 again -> 10 */
    g_counter += 2;              /* direct access -> 12 */
    printf("%d\n", g_counter);   /* expect 12; proves &g_counter aliased g_counter */
    return 0;
}
