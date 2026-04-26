#include <stdio.h>

int main() {
  // Comma operator evaluates left, discards, returns right
  int x = (1, 2, 3);
  printf("%d\n", x); // 3

  // Side effects in comma
  int a = 0;
  int b = (a = 5, a + 1);
  printf("%d %d\n", a, b); // 5 6

  return 0;
}
