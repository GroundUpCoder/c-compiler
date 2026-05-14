#include <stdio.h>

enum {
    A = (~0U > 0xffffU) ? 1 : 0,
    B = (1U - 2U > 0U) ? 1 : 0,
    C = (~0U),
    D = ((unsigned)(~0U) > 100U) ? 1 : 0,
};

int main(void) {
    printf("~0U > 0xffffU: %d\n", A);
    printf("1U - 2U > 0U: %d\n", B);
    printf("~0U: %u\n", (unsigned)C);
    printf("~0U > 100U: %d\n", D);

    // Array size from unsigned constant expression
    int arr[(~0U > 0) ? 3 : 1];
    arr[0] = 10; arr[1] = 20; arr[2] = 30;
    printf("arr: %d %d %d\n", arr[0], arr[1], arr[2]);

    return 0;
}
