// BUG: Local array declared inside catch body crashes compiler
// Same root cause: DFS doesn't walk into TRY_CATCH bodies
#include <stdio.h>

__exception Err(int);

int main() {
    __try {
        __throw Err(42);
    } __catch Err(val) {
        int arr[3];  // MEMORY-class var inside catch body
        arr[0] = val;
        arr[1] = val * 2;
        arr[2] = val * 3;
        printf("arr: %d %d %d\n", arr[0], arr[1], arr[2]);
    }
    return 0;
}
