// C11 6.5.3.4p1: "_Alignof shall not be applied to ... an incomplete type"
#include <stdio.h>

struct Incomplete;

int main(void) {
    printf("%lu\n", (unsigned long)_Alignof(struct Incomplete));
    return 0;
}
