#include <stdio.h>

int garr[2][3] = {{1, 2, 3}, {4, 5, 6}};
int garr2[3][2];  // uninitialized

void test_local_2d() {
  printf("=== Local 2D arrays ===\n");
  int arr[2][3];
  arr[0][0] = 1;
  arr[0][1] = 2;
  arr[0][2] = 3;
  arr[1][0] = 4;
  arr[1][1] = 5;
  arr[1][2] = 6;

  printf("arr[0][0] = %d\n", arr[0][0]);
  printf("arr[0][1] = %d\n", arr[0][1]);
  printf("arr[0][2] = %d\n", arr[0][2]);
  printf("arr[1][0] = %d\n", arr[1][0]);
  printf("arr[1][1] = %d\n", arr[1][1]);
  printf("arr[1][2] = %d\n", arr[1][2]);

  // Via pointer arithmetic
  int *p = &arr[0][0];
  printf("p[0] = %d\n", p[0]);
  printf("p[3] = %d\n", p[3]);
  printf("p[5] = %d\n", p[5]);
}

void test_local_2d_init() {
  printf("=== Local 2D array with initializer ===\n");
  int arr[2][3] = {{1, 2, 3}, {4, 5, 6}};
  printf("arr[0][0] = %d\n", arr[0][0]);
  printf("arr[1][2] = %d\n", arr[1][2]);

  int *p = &arr[0][0];
  printf("p[0] = %d\n", p[0]);
  printf("p[5] = %d\n", p[5]);
}

void test_global_2d() {
  printf("=== Global 2D arrays ===\n");
  printf("garr[0][0] = %d\n", garr[0][0]);
  printf("garr[0][2] = %d\n", garr[0][2]);
  printf("garr[1][0] = %d\n", garr[1][0]);
  printf("garr[1][2] = %d\n", garr[1][2]);

  garr[0][1] = 99;
  printf("garr[0][1] after assignment = %d\n", garr[0][1]);

  // Uninitialized global 2D array
  garr2[0][0] = 10;
  garr2[1][1] = 20;
  garr2[2][0] = 30;
  printf("garr2[0][0] = %d\n", garr2[0][0]);
  printf("garr2[1][1] = %d\n", garr2[1][1]);
  printf("garr2[2][0] = %d\n", garr2[2][0]);

  // Global via pointer
  int *p = &garr[0][0];
  printf("p[0] = %d\n", p[0]);
  printf("p[5] = %d\n", p[5]);
}

int main() {
  test_local_2d();
  test_local_2d_init();
  test_global_2d();
  return 0;
}
