#include <stdio.h>

int counter(void) {
  static int count = 0;
  count = count + 1;
  return count;
}

int main(void) {
  printf("%d\n", counter());
  printf("%d\n", counter());
  printf("%d\n", counter());
  return 0;
}
