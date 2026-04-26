#include <stdio.h>

/* ANSI function */
int ansi_add(int a, int b) {
    return a + b;
}

/* K&R function */
int knr_mul(a, b)
int a;
int b;
{
    return a * b;
}

/* ANSI calling K&R, K&R calling ANSI */
int knr_calls_ansi(x)
int x;
{
    return ansi_add(x, x);
}

int ansi_calls_knr(int x) {
    return knr_mul(x, x + 1);
}

int main(void) {
    printf("%d\n", ansi_add(2, 3));
    printf("%d\n", knr_mul(4, 5));
    printf("%d\n", knr_calls_ansi(6));
    printf("%d\n", ansi_calls_knr(7));
    printf("PASS\n");
    return 0;
}
