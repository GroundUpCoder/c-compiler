#include <stdio.h>

/* Implicit int return type */
add(int a, int b) {
    return a + b;
}

/* Implicit int with static */
static negate(int x) {
    return -x;
}

/* const implicit int */
const zero(void) {
    return 0;
}

int main(void) {
    printf("%d\n", add(10, 20));
    printf("%d\n", negate(5));
    printf("%d\n", zero());
    printf("PASS\n");
    return 0;
}
