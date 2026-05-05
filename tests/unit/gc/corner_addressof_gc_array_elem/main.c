// Address-of on a GC array element — should also be rejected
#include <stdio.h>

int main(void) {
    __array(int) arr = __new_array(int, 10, 20, 30);
    int *p = &arr[1];  // BUG: GC array memory isn't linear-addressable
    printf("%d\n", *p);
    return 0;
}
