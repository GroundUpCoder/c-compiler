#include <stdio.h>

/* Single parameter K&R */
int inc(x)
int x;
{
    return x + 1;
}

/* Single param, pointer type */
int deref(p)
int *p;
{
    return *p;
}

int main(void) {
    printf("%d\n", inc(99));
    int val = 42;
    printf("%d\n", deref(&val));
    printf("PASS\n");
    return 0;
}
