// BUG: for loop with local array inside try body
// Tests interaction of for-loop and try-catch in the DFS
#include <stdio.h>

__exception Err(int);

int main() {
    __try {
        for (int i = 0; i < 3; i++) {
            int buf[10];  // MEMORY-class var in for-loop inside try
            buf[i] = i * 10;
            printf("buf[%d] = %d\n", i, buf[i]);
        }
    } __catch Err(val) {
        printf("caught: %d\n", val);
    }
    return 0;
}
