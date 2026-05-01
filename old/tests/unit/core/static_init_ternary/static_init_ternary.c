#include <stdio.h>

int a = 1 ? 42 : 99;
int b = 0 ? 42 : 99;
int c = 1 ? (2 ? 10 : 20) : 30;
int d = 0 ? 10 : (1 ? 20 : 30);

int main(void) {
    printf("%d %d %d %d\n", a, b, c, d);
    return 0;
}
