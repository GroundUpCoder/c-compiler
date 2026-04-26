// C11 6.7.5p6: "An alignment specification of zero has no effect."
// _Alignas(0) should be silently ignored, not rejected.
#include <stdio.h>

_Alignas(0) int x = 42;

int main(void) {
    _Alignas(0) int y = 99;
    printf("%d %d\n", x, y);
    return 0;
}
