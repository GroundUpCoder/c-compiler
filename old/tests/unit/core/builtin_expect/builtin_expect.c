#include <stdio.h>

#define likely(x)   __builtin_expect(!!(x), 1)
#define unlikely(x) __builtin_expect(!!(x), 0)

int main(void) {
    int x = 42;
    if (likely(x == 42)) {
        printf("likely works\n");
    }
    if (unlikely(x == 0)) {
        printf("should not print\n");
    }
    /* __builtin_expect returns the first argument */
    printf("%d\n", (int)__builtin_expect(7, 0));
    printf("done\n");
    return 0;
}
