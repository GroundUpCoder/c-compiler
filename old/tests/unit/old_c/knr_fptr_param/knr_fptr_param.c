#include <stdio.h>

/* K&R with function pointer parameter */
int apply(f, x)
int (*f)(int);
int x;
{
    return f(x);
}

int square(int n) { return n * n; }
int negate(int n) { return -n; }

int main(void) {
    printf("%d\n", apply(square, 5));
    printf("%d\n", apply(negate, 7));
    printf("PASS\n");
    return 0;
}
