/* C99 F.10.3.12: modf's fractional result carries the sign of x, even
 * when the fraction is zero. x - trunc(x) gives +0.0. Found via
 * micropython's math_fun test (modf(-100) printed (0, -100)). */
#include <stdio.h>
#include <math.h>

static void show(double x) {
  double ip;
  double fp = modf(x, &ip);
  printf("%g %g %d\n", fp, ip, signbit(fp) ? 1 : 0);
}

int main(void) {
  show(-100.0);
  show(-1.0);
  show(-1.25);
  show(100.0);
  show(0.5);
  return 0;
}
