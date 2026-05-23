/* --force-dispatch-loop: forces every function through
 * IRREDUCIBLE_LOWERING regardless of whether its CFG is structurally
 * reducible. The output should be observationally identical to the
 * default (structured) codegen. This test exercises the easy cases —
 * if-else, while, switch, function call — to make sure the forced
 * dispatch-loop wrapper is correct for trivially-reducible bodies too.
 */
#include <stdio.h>

int fib(int n) {
  int a = 0, b = 1;
  while (n > 0) {
    int t = a + b;
    a = b;
    b = t;
    n = n - 1;
  }
  return a;
}

int classify(int x) {
  if (x < 0) return -1;
  if (x == 0) return 0;
  switch (x % 3) {
    case 0: return 30;
    case 1: return 31;
    case 2: return 32;
  }
  return -999;
}

int main(void) {
  for (int i = 0; i < 8; i++) {
    printf("fib(%d) = %d\n", i, fib(i));
  }
  printf("classify: %d %d %d %d %d\n",
         classify(-5), classify(0), classify(3), classify(4), classify(5));
  return 0;
}
