#include <stdio.h>

void test_fill(void) {
  printf("=== fill ===\n");
  __array(int) a = __new(__array(int), 8);
  __array_fill(a, 2, 99, 4);
  for (int i = 0; i < __array_len(a); i++) printf("%d ", a[i]);
  printf("\n");

  // Fill entire array
  __array(int) b = __new(__array(int), 5);
  __array_fill(b, 0, 7, 5);
  for (int i = 0; i < __array_len(b); i++) printf("%d ", b[i]);
  printf("\n");

  // Float array
  __array(double) c = __new(__array(double), 3);
  __array_fill(c, 0, 2.5, 3);
  for (int i = 0; i < __array_len(c); i++) printf("%g ", c[i]);
  printf("\n");
}

void test_copy(void) {
  printf("=== copy ===\n");
  __array(int) src = __new_array(int, 10, 20, 30, 40, 50);
  __array(int) dst = __new(__array(int), 5);

  __array_copy(dst, 1, src, 0, 3);
  for (int i = 0; i < __array_len(dst); i++) printf("%d ", dst[i]);
  printf("\n");

  // Copy from middle
  __array_copy(dst, 0, src, 2, 3);
  for (int i = 0; i < __array_len(dst); i++) printf("%d ", dst[i]);
  printf("\n");

  // Copy whole array to another
  __array(int) dst2 = __new(__array(int), 5);
  __array_copy(dst2, 0, src, 0, 5);
  for (int i = 0; i < __array_len(dst2); i++) printf("%d ", dst2[i]);
  printf("\n");
}

void test_overlap(void) {
  printf("=== overlap ===\n");
  // Overlapping copy within the same array — WASM array.copy handles this
  __array(int) a = __new_array(int, 1, 2, 3, 4, 5);
  __array_copy(a, 1, a, 0, 4);   // shift right by 1
  for (int i = 0; i < __array_len(a); i++) printf("%d ", a[i]);
  printf("\n");
}

int main(void) {
  test_fill();
  test_copy();
  test_overlap();
  return 0;
}
