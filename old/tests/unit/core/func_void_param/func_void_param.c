/* Test that f(void) means zero parameters and works correctly */
#include <stdio.h>

/* Forward declare with (void) - explicit zero params */
int foo(void);
int bar(void);

int foo(void) {
    return 42;
}

/* Declare and define separately */
int bar(void) {
    return 99;
}

/* typedef with void param */
typedef int (*voidfunc)(void);

int main(void) {
    printf("%d\n", foo());
    printf("%d\n", bar());

    voidfunc f = foo;
    printf("%d\n", f());

    return 0;
}
