/* C99 F.9.4.4: pow(x, +-0) = 1 for any x (even NaN); pow(+1, y) = 1 for
 * any y (even NaN/inf). The JS host's Math.pow returns NaN for those. */
#include <stdio.h>
#include <math.h>

int main(void) {
  printf("%g %g %g\n", pow(1.0, NAN), pow(NAN, 0.0), pow(1.0, INFINITY));
  printf("%g %g %g\n", pow(INFINITY, 0.0), pow(-NAN, 0.0), pow(1.0, -INFINITY));
  printf("%g %g\n", pow(2.0, 10.0), pow(-3.0, 2.0));
  printf("%d %d\n", isnan(pow(NAN, 1.0)) ? 1 : 0, isnan(pow(2.0, NAN)) ? 1 : 0);
  return 0;
}
