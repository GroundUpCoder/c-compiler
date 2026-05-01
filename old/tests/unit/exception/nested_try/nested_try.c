#include <stdio.h>
__exception Outer(int);
__exception Inner(int);

int main() {
    __try {
        __try {
            __throw Inner(10);
        } __catch Inner(val) {
            printf("inner caught: %d\n", val);
            __throw Outer(val + 1);
        }
    } __catch Outer(val) {
        printf("outer caught: %d\n", val);
    }
    return 0;
}
