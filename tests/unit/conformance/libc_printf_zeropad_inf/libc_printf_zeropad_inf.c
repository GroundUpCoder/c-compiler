// BUG: %010f / %010e zero-pad infinities and NaNs (e.g. "000000-inf") instead of space-padding.
// C11: 7.21.6.1p8 (f/e conversions) — an infinity/NaN argument is converted to [-]inf / [-]nan; the 0 flag is defined only for numeric padding "leading zeros ... to fill out the field width", and consensus (made normative in C23) is that 0 is ignored for inf/nan, giving space padding.
// EXPECT: "[       inf][       nan][      -inf]\n" (verified against native clang; the '+' flag variant was dropped because macOS libc prints "nan" without the sign, so its exact form is not portable).
#include <stdio.h>
#include <math.h>

int main(void) {
  printf("[%010f][%010f][%010e]\n", INFINITY, NAN, -INFINITY);
  return 0;
}
