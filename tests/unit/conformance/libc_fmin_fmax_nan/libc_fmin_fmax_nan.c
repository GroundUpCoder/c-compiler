// BUG: fmin/fmax (and the float variants) return NaN when either argument is NaN, instead of the numeric argument.
// C11: Annex F.10.9.2/F.10.9.3 — fmin/fmax treat a NaN argument as missing data: fmax(NaN,5.0)==5.0, fmin(5.0,NaN)==5.0; only fmin(NaN,NaN) is NaN.
// EXPECT: "5 5 5 5 nan\n" (verified against native clang).
#include <stdio.h>
#include <math.h>

int main(void) {
  printf("%g %g %g %g %g\n",
         fmax(NAN, 5.0), fmax(5.0, NAN),
         fmin(NAN, 5.0), (double)fminf(5.0f, NAN),
         fmin(NAN, NAN));
  return 0;
}
