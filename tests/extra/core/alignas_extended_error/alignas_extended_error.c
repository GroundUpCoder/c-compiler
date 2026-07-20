// C11 6.2.8: extended alignments (> max_align_t = 8 on wasm32) are
// implementation-defined. This compiler HONORS them (data section for static
// storage, over-aligned frame for automatic) rather than rejecting — matching
// clang. Previously `_Alignas(16)` was rejected "exceeds maximum supported
// alignment of 8" (todos/0194).
#include <stdio.h>
#include <stdint.h>
_Alignas(16) int x;
int main(void) {
    printf("%d\n", (int)((uintptr_t)&x % 16 == 0));
    return 0;
}
