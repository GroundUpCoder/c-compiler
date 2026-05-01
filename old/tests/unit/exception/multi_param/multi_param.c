#include <stdio.h>
__exception Pair(int, float);

int main() {
    __try {
        __throw Pair(7, 3.14f);
    } __catch Pair(x, y) {
        printf("caught: %d %.2f\n", x, (double)y);
    }
    return 0;
}
