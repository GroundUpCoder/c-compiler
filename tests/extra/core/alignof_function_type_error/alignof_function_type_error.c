// C11 6.5.3.4p1: "_Alignof shall not be applied to ... a function type"
#include <stdio.h>

typedef void fn_t(void);

int main(void) {
    printf("%lu\n", (unsigned long)_Alignof(fn_t));
    return 0;
}
