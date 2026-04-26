#include <stdio.h>

int a = 1 && 2;
int b = 0 && 2;
int c = 0 || 3;
int d = 0 || 0;
int e = 1 && 0;
int f = 5 || 0;

int main(void) {
    printf("%d %d %d %d %d %d\n", a, b, c, d, e, f);
    return 0;
}
