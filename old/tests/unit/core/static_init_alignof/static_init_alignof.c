#include <stdio.h>

struct S { int x; double d; };
int a = _Alignof(int);
int b = _Alignof(double);
int c = _Alignof(struct S);

int main(void) {
    printf("%d %d %d\n", a, b, c);
    return 0;
}
