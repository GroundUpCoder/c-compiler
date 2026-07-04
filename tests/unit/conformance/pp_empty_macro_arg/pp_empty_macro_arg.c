// BUG: an empty macro argument is not substituted as "nothing": M() expands
//      with the parameter left in place, so `a + 10` picks up the global `a`
//      (90) and prints 100.
// C11: 6.10.3p4 — arguments may consist of no preprocessing tokens; the
//      parameter is then replaced by nothing (6.10.3.1).
// EXPECT: M() -> `+ 10` (unary plus) == 10; N(,5) -> `+ 5 + 1` == 6.
#include <stdio.h>

#define M(a) a + 10
#define N(x,y) x + y + 1

int a = 90;

int main(void) {
  printf("%d\n", M());
  printf("%d\n", N(,5));
  return 0;
}
