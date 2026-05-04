#include <stdio.h>

int main(void) {
  __array(int) a = __new(__array(int), 5);
  printf("len: %d\n", __array_len(a));         // 5

  __array(double) d = __new(__array(double), 100, 1.5);
  printf("len: %d\n", __array_len(d));         // 100

  __array(int) e = __new_array(int, 1, 2, 3);
  printf("len: %d\n", __array_len(e));         // 3

  // __array_len works as a loop bound
  for (int i = 0; i < __array_len(e); i++) printf("%d ", e[i]);
  printf("\n");

  return 0;
}
