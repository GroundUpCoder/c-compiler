/* Test: object-like macro expanding to function-like macro name.
 *
 * When an object-like macro (ALIAS) expands to a function-like macro name
 * (FUNC), the rescan must combine the expanded name with the trailing '('
 * from the original token stream to form a complete macro invocation.
 *
 * This is the pattern FreeType uses: e.g.
 *   #define FT_NEXT_USHORT(buffer) (buffer += 2, ...)
 *   #define TT_NEXT_USHORT FT_NEXT_USHORT
 *   TT_NEXT_USHORT(p)  // must fully expand
 */

#include <stdio.h>

#define ADD_ONE(x)   ((x) + 1)
#define ALIAS_ADD    ADD_ONE
#define ALIAS_ALIAS  ALIAS_ADD

/* Multi-arg function-like macro */
#define ADD(a, b) ((a) + (b))
#define ALIAS_ADD2 ADD

int main(void) {
    int x = 10;

    /* Direct use of function-like macro */
    printf("%d\n", ADD_ONE(x));       /* 11 */

    /* Object-like alias to function-like macro */
    printf("%d\n", ALIAS_ADD(x));     /* 11 */

    /* Double-aliased */
    printf("%d\n", ALIAS_ALIAS(x));   /* 11 */

    /* Multi-arg through alias */
    printf("%d\n", ALIAS_ADD2(3, 4)); /* 7 */

    /* Used in expressions */
    int y = ALIAS_ADD(x) + ALIAS_ADD2(1, 2);
    printf("%d\n", y);                /* 14 */

    return 0;
}
