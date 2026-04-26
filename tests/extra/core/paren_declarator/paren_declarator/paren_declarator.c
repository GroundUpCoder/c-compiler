#include <stdio.h>

/* Parenthesized function name — prevents macro expansion of the name */
int (add)(int a, int b) {
    return a + b;
}

/* Declaration with parenthesized name */
int (mul)(int, int);

int (mul)(int a, int b) {
    return a * b;
}

int main(void) {
    printf("%d\n", add(3, 4));
    printf("%d\n", mul(5, 6));
    return 0;
}
