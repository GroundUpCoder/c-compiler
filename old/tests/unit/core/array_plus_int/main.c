#include <stdio.h>

int main() {
  int arr[5] = {10, 20, 30, 40, 50};

  // Subscript works fine
  printf("arr[2]: %d\n", arr[2]);  // 30

  // Pointer variable + int works fine
  int *p = arr;
  printf("*(p+2): %d\n", *(p + 2));  // 30

  // Array name + int: should work identically
  printf("*(arr+2): %d\n", *(arr + 2));  // expect 30

  // Store result of array + int
  int *q = arr + 3;
  printf("*(arr+3): %d\n", *q);  // expect 40

  return 0;
}
