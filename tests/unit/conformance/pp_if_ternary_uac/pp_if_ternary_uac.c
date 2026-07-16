// BUG: the #if ternary returns the chosen arm VERBATIM, skipping the usual
//      arithmetic conversions between the arms — (1 ? -1 : 0u) stays signed
//      -1 instead of converting to uintmax_t, so `>= 0` picks the wrong branch.
// C11: 6.5.15p5 via 6.10.1p4 — the arms undergo the usual arithmetic
//      conversions (in intmax_t/uintmax_t space): if either arm is unsigned,
//      the result is uintmax_t, and -1 converts to a huge unsigned value.
// EXPECT: A/B unsigned (mixed arms), C signed (both arms signed), D logical
//         (the unsigned result type carries into a following right-shift).
#include <stdio.h>

int main(void) {
#if (1 ? -1 : 0u) >= 0
  puts("A:unsigned");
#else
  puts("A:signed");
#endif
#if (0 ? 0u : -1) >= 0
  puts("B:unsigned");
#else
  puts("B:signed");
#endif
#if (1 ? -1 : 0) < 0
  puts("C:signed");
#else
  puts("C:unsigned");
#endif
#if ((0 ? 0u : -1) >> 63) == 1
  puts("D:logical");
#else
  puts("D:arith");
#endif
  return 0;
}
