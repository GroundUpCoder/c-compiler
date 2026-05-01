/* Test that f(void) conflicts with f(int) - should be a compile error */
#include <stdio.h>

int foo(void);
int foo(int x) {
    return x;
}

int main(void) {
    return 0;
}
