// BUG: Local struct declared inside try body crashes compiler
// Same root cause: DFS doesn't walk into TRY_CATCH bodies
#include <stdio.h>

__exception Err(int);

struct Point { int x; int y; };

int main() {
    __try {
        struct Point p;  // MEMORY-class var inside try body
        p.x = 10;
        p.y = 20;
        printf("p: %d %d\n", p.x, p.y);
    } __catch Err(val) {
        printf("caught: %d\n", val);
    }
    return 0;
}
