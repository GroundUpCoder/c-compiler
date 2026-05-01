#include <stdio.h>

/* Basic K&R function with two params */
int add(a, b)
int a;
int b;
{
    return a + b;
}

/* K&R with three params, different types */
long mixed(a, b, c)
int a;
char *b;
long c;
{
    return a + b[0] + c;
}

/* K&R returning void */
void greet(name)
char *name;
{
    printf("hello %s\n", name);
}

int main(void) {
    printf("%d\n", add(3, 4));
    printf("%ld\n", mixed(1, "X", 10));
    greet("world");
    printf("PASS\n");
    return 0;
}
