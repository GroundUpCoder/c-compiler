#include <stdio.h>
__exception MyError(int);

int main() {
    __try {
        printf("before throw\n");
        __throw MyError(42);
        printf("after throw\n");
    } __catch MyError(code) {
        printf("caught: %d\n", code);
    }
    printf("done\n");
    return 0;
}
