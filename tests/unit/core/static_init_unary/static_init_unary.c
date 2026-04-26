#include <stdio.h>

int a = +42;
int b = +(-10);
double c = +3.14;
int d = !0;
int e = !5;
int f = !0.0;
int g = !1.5;

int main(void) {
    printf("%d %d %f %d %d %d %d\n", a, b, c, d, e, f, g);
    return 0;
}
