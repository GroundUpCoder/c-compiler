// BUG: calling through an empty-parens function pointer with arguments typed the call_indirect off the 0-arg pointer type while promoted args were pushed — invalid wasm ("expected 0 elements on the stack for fallthru, found 3") or a spurious runtime signature trap
// C11: C89 6.5.2.2p6 — a call through a pointer with no prototype applies the default argument promotions; behavior is defined when the promoted argument types match the definition's (promoted) parameter types
// EXPECT: p(1.5, 2) reaches addup(double, int) through the unprototyped pointer and prints 3.5; matches native clang -std=c89
#include <stdio.h>
double addup(double a, int b) { return a + b; }
int main(void) {
  double (*p)() = addup;
  printf("%g\n", p(1.5, 2));
  return 0;
}
