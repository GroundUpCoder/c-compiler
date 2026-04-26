#include <stdio.h>
__exception Err(int);

int main() {
    __try {
        __throw Err(1);
    } __catch {
        printf("catch_all\n");
    } __catch Err(val) {
        printf("err: %d\n", val);
    }
    return 0;
}
