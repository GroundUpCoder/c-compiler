// BUG: #if expressions are evaluated at 32 bits, so 64-bit integer constants
//      truncate and (1<<31) goes negative — all four conditions pick the wrong branch.
// C11: 6.10.1p4 — in #if, integer constants act as if they have type intmax_t
//      (or uintmax_t), i.e. at least 64 bits.
// EXPECT: 0x100000000 is nonzero; 0xFFFFFFFF+1 == 0x100000000 != 0 (no wrap);
//         5000000000 > 4000000000; (1<<31) == 2147483648 > 0 in intmax_t.
#include <stdio.h>

int main(void) {
#if 0x100000000
  puts("A:true");
#else
  puts("A:false");
#endif
#if (0xFFFFFFFF + 1) == 0
  puts("B:wrap");
#else
  puts("B:nowrap");
#endif
#if 5000000000 > 4000000000
  puts("C:gt");
#else
  puts("C:ngt");
#endif
#if (1 << 31) < 0
  puts("D:neg");
#else
  puts("D:pos");
#endif
  return 0;
}
