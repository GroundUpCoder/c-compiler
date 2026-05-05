// Address-of operator on a GC struct's int field
// &p->x should be rejected — GC memory is not linear-addressable
#include <stdio.h>

__struct Point { int x; int y; };

int main(void) {
    __struct Point *p = __new(__struct Point *, 10, 20);
    int *px = &p->x;  // BUG: should be rejected, GC fields aren't addressable
    printf("%d\n", *px);
    return 0;
}
