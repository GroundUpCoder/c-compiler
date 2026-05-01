#include <stdio.h>

int main() {
  // Multiple variable declarations in one statement
  int a, b, c;
  a = 1;
  b = 2;
  c = 3;
  printf("%d %d %d\n", a, b, c);

  // With initializers
  int x = 10, y = 20, z = 30;
  printf("%d %d %d\n", x, y, z);

  // Mixed initialized and uninitialized
  int p = 100, q, r = 300;
  q = 200;
  printf("%d %d %d\n", p, q, r);

  return 0;
}
