#include <stdio.h>
__exception Err(int);

void thrower(int x) {
    __throw Err(x * 2);
}

int main() {
    __try {
        thrower(5);
    } __catch Err(val) {
        printf("caught: %d\n", val);
    }
    return 0;
}
