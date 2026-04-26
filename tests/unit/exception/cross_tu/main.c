#include <stdio.h>

__exception CrossErr(int);

void do_throw(int x);

int main() {
    __try {
        do_throw(77);
    } __catch CrossErr(val) {
        printf("caught cross-tu: %d\n", val);
    }
    return 0;
}
