#include <stdio.h>

// Global designated array init
int ga1[5] = {[3] = 10};

// Global mixed
int ga2[5] = {1, 2, [4] = 99};

// Global size inference
int ga3[] = {[4] = 42};

int main() {
    // Local designated array init
    int a1[5] = {[3] = 10};
    printf("a1:");
    for (int i = 0; i < 5; i++) printf(" %d", a1[i]);
    printf("\n");

    // Sparse array
    int a2[5] = {[1] = 11, [3] = 33};
    printf("a2:");
    for (int i = 0; i < 5; i++) printf(" %d", a2[i]);
    printf("\n");

    // Mixed positional + designated
    int a3[5] = {1, 2, [4] = 99};
    printf("a3:");
    for (int i = 0; i < 5; i++) printf(" %d", a3[i]);
    printf("\n");

    // Size inference from designator
    int a4[] = {[4] = 42};
    printf("a4:");
    for (int i = 0; i < 5; i++) printf(" %d", a4[i]);
    printf("\n");

    // Size inference with mixed
    int a5[] = {10, [3] = 30};
    printf("a5:");
    for (int i = 0; i < 4; i++) printf(" %d", a5[i]);
    printf("\n");

    // Globals
    printf("ga1:");
    for (int i = 0; i < 5; i++) printf(" %d", ga1[i]);
    printf("\n");

    printf("ga2:");
    for (int i = 0; i < 5; i++) printf(" %d", ga2[i]);
    printf("\n");

    printf("ga3:");
    for (int i = 0; i < 5; i++) printf(" %d", ga3[i]);
    printf("\n");

    return 0;
}
