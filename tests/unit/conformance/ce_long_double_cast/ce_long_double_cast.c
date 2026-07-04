// BUG: constant evaluation treats a (long double)-typed operand as an
//      integer, so (long double)3 / 2 folds with integer division to 1.0
//      and the program prints 1.000000.
// C11: 6.3.1.8p1 — if either operand has type long double, the other is
//      converted to long double and the division is performed in long double:
//      3.0L / 2 == 1.5L.
// EXPECT: 1.500000 (verified against native clang).
#include <stdio.h>

static long double sld = (long double)3 / 2;

int main(void) {
  printf("%f\n", (double)sld);
  return 0;
}
