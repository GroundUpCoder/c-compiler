#include <stdio.h>

#define PASTE(a, b) a##b
#define VAR(n) var_##n

int main() {
  int PASTE(foo, bar) = 42;
  printf("%d\n", foobar);

  int VAR(1) = 10;
  int VAR(2) = 20;
  printf("%d %d\n", var_1, var_2);

  // Paste forming a number
  int x = PASTE(1, 0);
  printf("%d\n", x);

  return 0;
}
