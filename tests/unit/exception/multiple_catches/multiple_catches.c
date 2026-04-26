#include <stdio.h>
__exception ErrA(int);
__exception ErrB(int);

int main() {
    __try {
        __throw ErrB(20);
    } __catch ErrA(a) {
        printf("A: %d\n", a);
    } __catch ErrB(b) {
        printf("B: %d\n", b);
    }
    return 0;
}
