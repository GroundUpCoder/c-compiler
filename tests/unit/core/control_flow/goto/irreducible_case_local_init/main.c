/* Regression: in a function forced through irreducible lowering (cross-
 * case goto into a nested block), a case-local aggregate initializer
 * with non-constant elements was kept on the hoisted declaration and
 * evaluated at FUNCTION ENTRY — before the values it reads exist.
 * Found via micropython: divmod() built its result tuple from zeros.
 * Non-constant aggregate inits must be reproduced in place. */
#include <stdio.h>

static double slots[8];
static int n;
static void *mk(double v) { double *p = &slots[n++]; *p = v; return p; }

struct Pair { void *a; void *b; char tag[4]; };

void *f(int op, double x, double y) {
  switch (op) {
    case 0:
      if (y == 0) {
      zde:
        printf("zde\n");
        return 0;
      }
      x = x / y;
      break;
    case 1: {
      if (y == 0) goto zde;
      void *p0 = mk(x);
      void *p1 = mk(y);
      void *t[2] = { p0, p1 };
      printf("t: %g %g\n", *(double *)t[0], *(double *)t[1]);
      struct Pair pr = { p1, p0, "ab" };
      printf("pr: %g %g %s\n", *(double *)pr.a, *(double *)pr.b, pr.tag);
      return t[0];
    }
    case 2: {
      if (y == 0) goto zde;
      /* constant aggregate init stays entry-evaluated — must still work */
      int c[3] = { 7, 8, 9 };
      printf("c: %d %d %d\n", c[0], c[1], c[2]);
      break;
    }
  }
  return mk(x);
}

int main(void) {
  f(1, 9.0, 4.0);
  f(2, 1.0, 1.0);
  f(0, 1.0, 0.0);
  return 0;
}
