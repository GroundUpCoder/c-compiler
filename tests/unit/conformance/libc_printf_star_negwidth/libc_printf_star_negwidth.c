// BUG: a negative width passed via '*' is ignored instead of being treated as '-' flag plus positive width.
// C11: 7.21.6.1p5 — "A negative field width argument is taken as a - flag followed by a positive field width."
// EXPECT: "[42    ][ab   ][42    ]\n" (verified against native clang).
#include <stdio.h>

int main(void) {
  printf("[%*d][%*s][%-*d]\n", -6, 42, -5, "ab", 6, 42);
  return 0;
}
