#include <stdio.h>
#include <stdlib.h>

void set_via_pp(int **pp, int val) {
  **pp = val;
}

int main() {
  // Basic pointer-to-pointer
  int x = 10;
  int *p = &x;
  int **pp = &p;
  printf("%d %d %d\n", x, *p, **pp);

  // Modify through double pointer
  **pp = 20;
  printf("%d\n", x);

  // Reassign the inner pointer
  int y = 30;
  *pp = &y;
  printf("%d\n", *p);  // p now points to y

  // Function taking pointer-to-pointer
  int z = 0;
  int *pz = &z;
  set_via_pp(&pz, 99);
  printf("%d\n", z);

  // Array of pointers (simulating char *argv[])
  int a = 1, b = 2, c = 3;
  int *arr[3];
  arr[0] = &a;
  arr[1] = &b;
  arr[2] = &c;
  int **pArr = arr;
  printf("%d %d %d\n", *pArr[0], *pArr[1], *pArr[2]);

  // Pointer-to-pointer with malloc
  int *heap = (int *)malloc(sizeof(int) * 3);
  heap[0] = 100;
  heap[1] = 200;
  heap[2] = 300;
  int **ph = &heap;
  printf("%d %d %d\n", (*ph)[0], (*ph)[1], (*ph)[2]);
  free(heap);

  return 0;
}
