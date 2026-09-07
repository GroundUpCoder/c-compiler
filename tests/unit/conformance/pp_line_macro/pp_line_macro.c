// BUG #650: #line was applied after macro expansion, so __LINE__/__FILE__
// reached through another macro used physical rather than presumed locations.
// C11 6.10.4 and 6.10.8.1; runtime golden verified with native Clang.
#include <stdio.h>
#define L __LINE__
#define F() __FILE__
#define LOC() printf("%s:%d:%d\n", F(), L, __LINE__)
#define ID(x) x
#define ALIAS ID
#define CAT(a,b) a ## b
#line 100 "outer.c"
int main(void) {
    LOC();
    printf("%s:%d:%d\n", ID(F()), ID(L), CAT(__LI,NE__));
    printf("%d\n", ALIAS(L));
    printf("%d\n", ID(
        L));
#include "pp_line_macro.h"
    LOC();
#line 200 "condition.c"
#if L != 200
#error wrong macro line in if
#endif
#line 300
#if 0
#elif L == 301
    puts("conditional-ok");
#else
#error wrong macro line in elif
#endif
#line 900 "last.c"
    LOC();
#line 10
    LOC();
    return 0;
}
