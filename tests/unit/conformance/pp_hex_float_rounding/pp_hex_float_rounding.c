// BUG: hexadecimal floating constants with excess mantissa digits are not
//      correctly rounded: sticky bits beyond the 53rd significand bit are
//      dropped, so the first constant collapses to exactly 1.0.
// C11: 6.4.4.2p3 — a hexadecimal floating constant must be rounded correctly
//      to the nearest representable value (FLT_RADIX 2).
// EXPECT: line 1: guard bit set + nonzero sticky bits -> rounds UP to
//         0x1.0000000000001p0, so d1 == 1.0 is 0.
//         line 2: guard bit set, sticky zero -> ties-to-even rounds DOWN to
//         exactly 1.0, so d2 == 1.0 is 1.
//         line 3: odd LSB + guard set, sticky zero -> ties-to-even rounds UP,
//         so d3 == 0x1.0000000000002p0 is 1.
// (Verified against native clang: prints 0 1 1.)
#include <stdio.h>

int main(void) {
  double d1 = 0x1.000000000000080000000000000001p0;
  printf("%d\n", d1 == 1.0);
  double d2 = 0x1.00000000000008p0;
  printf("%d\n", d2 == 1.0);
  double d3 = 0x1.00000000000018p0;
  printf("%d\n", d3 == 0x1.0000000000002p0);
  return 0;
}
