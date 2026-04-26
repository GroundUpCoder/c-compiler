#include <stdio.h>

int classify(int x) {
  if (x > 0) return 1;
  if (x < 0) return -1;
  return 0;
  __builtin_unreachable();
}

int main(void) {
  printf("%d %d %d\n", classify(-5), classify(0), classify(42));
  return 0;
}
