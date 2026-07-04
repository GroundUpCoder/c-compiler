// BUG: modf(+/-INFINITY, &ip) returns NaN for the fractional part instead of +/-0 with ip = +/-infinity.
// C11: Annex F.10.3.12 — modf(+/-inf, iptr) returns +/-0 and stores +/-inf in *iptr.
// EXPECT: "0 inf\n-0 -inf\n" — sign of the zero fraction checked explicitly via signbit (verified against native clang).
#include <stdio.h>
#include <math.h>

int main(void) {
  double ip, fr;
  fr = modf(INFINITY, &ip);
  printf("%s %s\n", (fr == 0.0 && !signbit(fr)) ? "0" : "bad-frac",
                    (isinf(ip) && ip > 0) ? "inf" : "bad-int");
  fr = modf(-INFINITY, &ip);
  printf("%s %s\n", (fr == 0.0 && signbit(fr)) ? "-0" : "bad-frac",
                    (isinf(ip) && ip < 0) ? "-inf" : "bad-int");
  return 0;
}
