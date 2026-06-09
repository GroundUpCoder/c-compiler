/* Regression battery for printf floating-point formatting:
 * - %g must strip trailing zeros in exponential form and switch to
 *   e-notation when exponent < -4 (POSIX), not < -7 (JS toPrecision)
 * - rounding must be round-half-even, not half-away-from-zero
 * - -0.0 must keep its sign in %f/%e
 * - %Lf/%Le/%Lg: long double is f64 on this target, format as double */
#include <stdio.h>

int main(void) {
  printf("%g %g %G %g %g\n", 1000000.0, 1e10, 1e-20, 100000.0, 123456.0);
  printf("%g %g %.2g %g\n", 1e-5, 0.000012345, 0.000076543, 0.0001);
  printf("%.0f %.0f %.0f %.0f\n", 0.5, 1.5, 2.5, 3.5);
  printf("%.1f %.1f %.2f\n", 0.25, 0.35, 0.125);
  printf("%.2e %.1e\n", 1005.0, 25.0);
  printf("%f %e %g\n", -0.0, -0.0, -0.0);
  printf("%Lf %Le %Lg\n", 2.5L, 2.5L, 2.5L);
  printf("%g %g %g\n", 0.1, 3.14159, 1.5e300);
  printf("%.17g\n", 0.1);
  printf("%e %f\n", 12345.6789, 12345.6789);
  return 0;
}
