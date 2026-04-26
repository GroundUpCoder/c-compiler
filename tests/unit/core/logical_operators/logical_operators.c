// Tests for && and || with various value patterns.
// These caught a real bug: bitwise AND of raw values instead of booleans.
#include <stdio.h>

int side_effect_counter;
int inc() { side_effect_counter++; return 1; }
int zero() { return 0; }

int main() {
  // Basic truthiness with non-boolean values
  printf("%d\n", 1 && 1);
  printf("%d\n", 1 && 0);
  printf("%d\n", 0 && 1);
  printf("%d\n", 5 && 3);
  printf("%d\n", 100 && 200);

  // OR
  printf("%d\n", 0 || 0);
  printf("%d\n", 1 || 0);
  printf("%d\n", 0 || 1);
  printf("%d\n", 5 || 0);

  // Chained
  printf("%d\n", 1 && 2 && 3);
  printf("%d\n", 1 && 0 && 3);
  printf("%d\n", 0 || 0 || 1);
  printf("%d\n", 0 || 0 || 0);

  // Short-circuit: right side should NOT execute if left decides result
  side_effect_counter = 0;
  int r1 = 0 && inc();
  printf("sc_and: r=%d count=%d\n", r1, side_effect_counter);

  side_effect_counter = 0;
  int r2 = 1 || inc();
  printf("sc_or: r=%d count=%d\n", r2, side_effect_counter);

  // Negation
  printf("%d\n", !0);
  printf("%d\n", !1);
  printf("%d\n", !42);
  printf("%d\n", !!42);

  return 0;
}
