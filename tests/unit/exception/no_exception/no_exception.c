#include <stdio.h>
__exception Err(int);

int main() {
    __try {
        printf("no throw\n");
    } __catch Err(val) {
        printf("caught: %d\n", val);
    }
    printf("done\n");
    return 0;
}
