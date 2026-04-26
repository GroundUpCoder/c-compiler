// BUG: Local array declared inside try body crashes compiler
// Root cause: the DFS that collects MEMORY-allocated variables
// doesn't walk into TRY_CATCH statement bodies
#include <stdio.h>

__exception Err(int);

int main() {
    __try {
        int arr[3];  // MEMORY-class var inside try body
        arr[0] = 10;
        arr[1] = 20;
        arr[2] = 30;
        printf("arr: %d %d %d\n", arr[0], arr[1], arr[2]);
    } __catch Err(val) {
        printf("caught: %d\n", val);
    }
    return 0;
}
