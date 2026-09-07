// BUG #650: C23 6.10.4.1 requires placemarkers for empty __VA_OPT__.
#include <stdio.h>
#define EMPTY
#define STR_RAW(...) #__VA_ARGS__
#define STR(...) STR_RAW(__VA_ARGS__)
#define LEFT(...) pre ## __VA_OPT__(fix)
#define RIGHT(...) __VA_OPT__(pre) ## fix
#define BOTH(...) a ## __VA_OPT__(mid) ## z
#define INNER(X, ...) __VA_OPT__(a X ## X) ## b
#define STRINGIZED(X, ...) #__VA_OPT__(X ## X X ## X)
#define TWO(...) __VA_OPT__()/**/__VA_OPT__()
#define WRAP_RAW(X) a ## X ## b
#define WRAP(X) WRAP_RAW(X)
#define JOIN(X, Y, ...) __VA_OPT__(X ## Y,) __VA_ARGS__
int main(void) {
    puts(STR(LEFT()));
    puts(STR(LEFT(EMPTY)));
    puts(STR(LEFT(1)));
    puts(STR(RIGHT()));
    puts(STR(RIGHT(1)));
    puts(STR(BOTH()));
    puts(STR(BOTH(1)));
    puts(STR(INNER(, 1)));
    puts(STR(INNER(c, 1)));
    puts(STRINGIZED(, 0));
    puts(STRINGIZED(a, 0));
    puts(STRINGIZED(a));
    puts(STR(WRAP(TWO())));
    puts(STR(WRAP(TWO(1))));
    puts(STR(JOIN(a,b,c,d)));
    return 0;
}
