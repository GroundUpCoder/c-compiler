// C11 6.5.3.4p1: "_Alignof shall not be applied to ... an incomplete type"
// void is an incomplete type that can never be completed.
#include <stdio.h>

int main(void) {
    printf("%lu\n", (unsigned long)_Alignof(void));
    return 0;
}
