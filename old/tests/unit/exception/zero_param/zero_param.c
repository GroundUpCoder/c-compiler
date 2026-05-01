#include <stdio.h>
__exception Signal();

int main() {
    __try {
        printf("throwing\n");
        __throw Signal();
    } __catch Signal() {
        printf("caught signal\n");
    }
    printf("done\n");
    return 0;
}
