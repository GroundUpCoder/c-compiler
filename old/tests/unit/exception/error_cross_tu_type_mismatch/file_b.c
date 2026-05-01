#include <stdio.h>

__exception Mismatch(float);

void do_throw(void);

int main() {
    __try {
        do_throw();
    } __catch Mismatch(val) {
        printf("%f\n", (double)val);
    }
    return 0;
}
