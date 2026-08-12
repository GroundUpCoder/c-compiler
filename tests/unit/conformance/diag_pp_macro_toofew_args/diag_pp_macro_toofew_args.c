// BUG: a function-like macro invoked with too few arguments was accepted
//      with no diagnostic; the unbound parameter NAME survived into the
//      expansion and captured an in-scope identifier of the same name —
//      M(1,2) below printed 1003 (1+2+c) instead of erroring (#642).
// C11: 6.10.3p4 (constraint) — the number of arguments (including those
//      consisting of no preprocessing tokens) shall equal the number of
//      parameters, unless the definition ends in `...`.
// EXPECT: compile error (exit 1).
#include <stdio.h>

#define M(a,b,c) ((a) + (b) + (c))

int main(void) {
  int c = 1000;
  printf("%d\n", M(1, 2));
  return 0;
}
