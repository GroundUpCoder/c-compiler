// BUG: comparison and logical-! results in #if are typed as 32-bit int, so
//      ((1<2) << 31) wraps negative instead of yielding 2147483648, and
//      (1<2) << 35 is rejected ("invalid operands to '<<'") because a 32-bit
//      value can't shift by 35.
// C11: 6.10.1p4 — ALL #if arithmetic happens in intmax_t/uintmax_t width;
//      a comparison's 0/1 result is intmax_t, so shifting it by 31 or 35 is
//      well-defined and never wraps.
// EXPECT: E eq (1<<31 == 2147483648 in intmax_t), F/G nonzero (shifts past 32
//         accepted), H/I pos (==/&& results shift without wrapping).
#include <stdio.h>

int main(void) {
#if ((1<2) << 31) == 2147483648
  puts("E:eq");
#else
  puts("E:ne");
#endif
#if (1<2) << 35
  puts("F:nonzero");
#else
  puts("F:zero");
#endif
#if (!0) << 32
  puts("G:nonzero");
#else
  puts("G:zero");
#endif
#if ((1==1) << 31) > 0
  puts("H:pos");
#else
  puts("H:neg");
#endif
#if ((5 && 3) << 31) > 0
  puts("I:pos");
#else
  puts("I:neg");
#endif
  return 0;
}
