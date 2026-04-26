// BUG: Pointer subtraction where one operand is an array name doesn't
// decay the array to a pointer, producing a wrong result.
//
// `p - arr` should be equivalent to `p - &arr[0]`, but the array name
// isn't decayed in the subtraction code path.
//
// Pointer-pointer subtraction with two pointer variables works fine.
// Array names in addition (arr + N) and comparisons (arr == p) also
// work fine after the recent fix — only subtraction is affected.

#include <stdio.h>

int main() {
  int arr[5] = {10, 20, 30, 40, 50};
  int *p = &arr[3];

  // pointer - pointer (both vars): works
  int *q = &arr[0];
  printf("p-q: %d\n", (int)(p - q));       // 3

  // pointer - array name: broken
  printf("p-arr: %d\n", (int)(p - arr));    // expect 3

  // Idiomatic: count elements from start
  int *end = arr + 5;
  printf("end-arr: %d\n", (int)(end - arr));  // expect 5

  return 0;
}
