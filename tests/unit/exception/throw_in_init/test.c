// BUG: throw from a function called in a variable initializer
// The array in the second try block triggers the DFS bug
#include <stdio.h>

__exception Err(int);

int init_and_maybe_throw(int x) {
    if (x > 5) __throw Err(x);
    return x * 2;
}

int main() {
    // Throw during variable initialization
    __try {
        int a = init_and_maybe_throw(3);   // OK, a = 6
        int b = init_and_maybe_throw(10);  // throws Err(10)
        printf("a=%d b=%d\n", a, b);       // should not reach
    } __catch Err(val) {
        printf("caught init throw: %d\n", val);  // 10
    }

    // Throw in array element initializer
    __try {
        int arr[3];
        arr[0] = init_and_maybe_throw(1);
        arr[1] = init_and_maybe_throw(7);  // throws
        arr[2] = init_and_maybe_throw(2);
        printf("arr: %d %d %d\n", arr[0], arr[1], arr[2]);
    } __catch Err(val) {
        printf("caught arr init: %d\n", val);  // 7
    }

    return 0;
}
