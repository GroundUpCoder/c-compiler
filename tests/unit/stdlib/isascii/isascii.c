// todos/0325 Group A — isascii/toascii (XSI). _decimal.c calls isascii.
//
// The point of these over the is*() family is that they are defined for the
// WHOLE int range, not just unsigned char + EOF, so the negative and
// out-of-range cases below are the ones that matter.
#include <stdio.h>
#include <ctype.h>

int main(void) {
  printf("0=%d 65=%d 127=%d 128=%d 255=%d 256=%d\n",
         isascii(0), isascii(65), isascii(127), isascii(128), isascii(255), isascii(256));
  printf("neg1=%d neg128=%d big=%d\n", isascii(-1), isascii(-128), isascii(100000));
  printf("EOF=%d\n", isascii(EOF));

  int lo = 0, hi = 0;
  for (int c = -300; c < 400; c++) {
    if (isascii(c)) { lo++; if (c < 0 || c > 127) hi++; }
  }
  printf("count=%d outside=%d\n", lo, hi);   // exactly 128, none outside

  printf("toascii: 65=%d 321=%d neg1=%d\n", toascii(65), toascii(321), toascii(-1));

  // Real functions, not macros — numpy-style dispatch tables take addresses.
  int (*p)(int) = isascii;
  printf("addressable=%d\n", p(65) != 0);
  return 0;
}
