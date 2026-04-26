// BUG: Local array in nested try body
// Tests that the DFS fix would need to handle nested TRY_CATCH
#include <stdio.h>

__exception E1(int);
__exception E2(int);

int main() {
    __try {
        __try {
            int arr[5];  // MEMORY-class var in nested try
            arr[0] = 100;
            printf("inner: %d\n", arr[0]);
            __throw E1(arr[0]);
        } __catch E1(val) {
            printf("inner caught: %d\n", val);
            __throw E2(val + 1);
        }
    } __catch E2(val) {
        printf("outer caught: %d\n", val);
    }
    return 0;
}
