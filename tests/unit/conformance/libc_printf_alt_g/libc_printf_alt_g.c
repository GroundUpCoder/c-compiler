// BUG: %#g drops the required decimal point (and trailing zeros) — '#' has no effect on the g conversion.
// C11: 7.21.6.1p6 (# flag) — for g/G the result always contains a decimal-point character and trailing zeros are NOT removed.
// EXPECT: "[100.][1.e+02][1.]\n" (verified against native clang).
#include <stdio.h>

int main(void) {
  printf("[%#.3g][%#.0g][%#.1g]\n", 100.0, 100.0, 1.0);
  return 0;
}
