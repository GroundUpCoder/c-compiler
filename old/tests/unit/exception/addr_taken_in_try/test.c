// BUG: Address-taken variable inside try body crashes compiler
// Same root cause: DFS doesn't walk into TRY_CATCH bodies
#include <stdio.h>

__exception Err(int);

int main() {
    __try {
        int x = 42;
        int *p = &x;  // address taken -> x becomes MEMORY-class
        printf("x = %d, *p = %d\n", x, *p);
    } __catch Err(val) {
        printf("caught: %d\n", val);
    }
    return 0;
}
