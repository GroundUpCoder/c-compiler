#include <stdio.h>

/* Forward declaration with ANSI prototype, K&R definition */
int compute(int a, int b);

int compute(a, b)
int a;
int b;
{
    return a * 10 + b;
}

int main(void) {
    printf("%d\n", compute(3, 7));
    printf("PASS\n");
    return 0;
}
