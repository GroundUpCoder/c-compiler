/* Test that f() means unspecified parameters (C89 semantics) */
/* f() should be compatible with f(int) etc. during linking */
#include <stdio.h>

/* Forward declare with () - unspecified params */
int foo();

/* Define with actual params - should be compatible with () decl */
int foo(int x, int y) {
    return x + y;
}

/* Declare with (), define with (void) - also compatible */
int bar();
int bar(void) {
    return 123;
}

int main(void) {
    printf("%d\n", foo(10, 20));
    printf("%d\n", bar());
    return 0;
}
