/* Regression: arrays didn't decay when converting to _Bool. */
#include <stdio.h>

int arr[1];

int main(void) {
  _Bool b = arr;
  printf("%d\n", b);
  double *p = 0;
  _Bool b2 = p;
  printf("%d\n", b2);
  if (arr) printf("truthy\n");
  return 0;
}
