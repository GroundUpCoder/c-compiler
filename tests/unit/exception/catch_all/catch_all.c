#include <stdio.h>
__exception Foo(int);

int main() {
    __try {
        __throw Foo(99);
    } __catch {
        printf("catch_all\n");
    }
    return 0;
}
