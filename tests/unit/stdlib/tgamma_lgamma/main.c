/* Regression: tgamma() and lgamma(x < 0.5) crashed the host with
 * "TypeError: this.lgamma is not a function" — wasm imports are
 * invoked with this === undefined. */
#include <stdio.h>
#include <math.h>

int main(void) {
  printf("%g %g\n", tgamma(5.0), tgamma(0.5) * tgamma(0.5));
  printf("%g %g\n", lgamma(0.3), lgamma(10.0));
  printf("%g\n", tgamma(-0.5));
  return 0;
}
