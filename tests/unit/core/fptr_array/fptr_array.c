/* Array of function pointers, call through double pointer */
#include <stdio.h>

int add(int a, int b) { return a + b; }
int sub(int a, int b) { return a - b; }
int mul(int a, int b) { return a * b; }

int main(void) {
    int (*ops[3])(int, int) = { add, sub, mul };
    if (ops[0](10, 3) != 13) { printf("FAIL: ops[0]\n"); return 1; }
    if (ops[1](10, 3) != 7) { printf("FAIL: ops[1]\n"); return 1; }
    if (ops[2](10, 3) != 30) { printf("FAIL: ops[2]\n"); return 1; }

    /* Call through pointer-to-array */
    int (**pp)(int, int) = ops;
    if (pp[0](5, 5) != 10) { printf("FAIL: pp[0]\n"); return 1; }
    if (pp[2](4, 5) != 20) { printf("FAIL: pp[2]\n"); return 1; }

    /* Index via loop */
    int results[] = { 13, 7, 30 };
    for (int i = 0; i < 3; i++) {
        if (ops[i](10, 3) != results[i]) {
            printf("FAIL: ops[%d]\n", i);
            return 1;
        }
    }

    printf("PASS\n");
    return 0;
}
