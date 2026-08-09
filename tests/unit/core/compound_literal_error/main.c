#include <stdio.h>

struct S { int a; int b; };
struct S *s = &(struct S) { 1, 2 };

int main() {
    printf("%d %d\n", s->a, s->b);
    return 0;
}
