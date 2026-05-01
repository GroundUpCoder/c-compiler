#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>

int main(void) {
    // Basic aligned_alloc with various alignments
    void *p1 = aligned_alloc(1, 10);
    void *p2 = aligned_alloc(2, 10);
    void *p4 = aligned_alloc(4, 12);
    void *p8 = aligned_alloc(8, 16);

    printf("p1: %d\n", p1 != NULL);
    printf("p2: %d\n", p2 != NULL);
    printf("p4: %d\n", p4 != NULL);
    printf("p8: %d\n", p8 != NULL);

    // Check alignment
    printf("p2 aligned: %d\n", ((uintptr_t)p2 % 2) == 0);
    printf("p4 aligned: %d\n", ((uintptr_t)p4 % 4) == 0);
    printf("p8 aligned: %d\n", ((uintptr_t)p8 % 8) == 0);

    // Write and read back
    int *arr = (int *)aligned_alloc(4, 12);
    arr[0] = 10;
    arr[1] = 20;
    arr[2] = 30;
    printf("%d %d %d\n", arr[0], arr[1], arr[2]);

    // Invalid: alignment not power of 2
    void *bad1 = aligned_alloc(3, 9);
    printf("bad1: %d\n", bad1 == NULL);

    // Invalid: size not multiple of alignment
    void *bad2 = aligned_alloc(4, 7);
    printf("bad2: %d\n", bad2 == NULL);

    // Alignment > 8 returns NULL (not supported on wasm32)
    void *big = aligned_alloc(16, 16);
    printf("big: %d\n", big == NULL);

    free(p1);
    free(p2);
    free(p4);
    free(p8);
    free(arr);

    return 0;
}
