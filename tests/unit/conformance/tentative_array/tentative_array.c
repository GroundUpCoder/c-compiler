// BUG: a tentative unsized array (`int arr2[];`) was allocated 0 bytes —
// sizeOf(incomplete array) is 0 at the allocateStatic call — so the NEXT
// global landed at the same address and arr2[0]=... clobbered it. Found
// in the 2026-07 fresh-eyes hunt (todos/0204).
// C11: 6.9.2p2 (EXAMPLE 2) — at end of TU a still-incomplete tentative
// array is completed to one element with implicit zero initializer.
// EXPECT: matches gcc/clang: arr2 and sarr each get their own int; no
// overlap with the neighbouring globals.
#include <stdio.h>

int arr2[];
int next = 42;
static int sarr[];
int after = 7;

int main(void) {
    printf("zero: %d %d\n", arr2[0], sarr[0]);
    arr2[0] = 99;
    sarr[0] = 88;
    printf("vals: %d %d %d %d\n", arr2[0], next, sarr[0], after);
    return 0;
}
