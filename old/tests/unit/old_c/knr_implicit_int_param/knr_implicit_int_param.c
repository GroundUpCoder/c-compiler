#include <stdio.h>

/* K&R with undeclared param — defaults to int */
int double_it(x)
{
    return x * 2;
}

/* Multiple params, only some declared */
int partial(a, b, c)
int a;
/* b is undeclared — defaults to int */
long c;
{
    return a + b + (int)c;
}

int main(void) {
    printf("%d\n", double_it(21));
    printf("%d\n", partial(1, 2, 3));
    printf("PASS\n");
    return 0;
}
