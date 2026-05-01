#include <stdio.h>

/* Definition with actual parameters */
void foo(int a, int b) {
    printf("%d\n", a + b);
}

int call_foo(void);

int main(void) {
    call_foo();
    return 0;
}
