// BUG: an unsigned right operand of a shift makes the whole shift unsigned,
//      so -1 >> 1u becomes a logical shift and (1 << 20u) - 2000000 wraps
//      to a huge unsigned value instead of going negative.
// C11: 6.5.7p3 — the type of a shift result is the promoted LEFT operand;
//      the right operand's type/signedness does not affect it. In #if
//      (6.10.1p4) -1 is intmax_t, so -1 >> 1u is an arithmetic shift == -1,
//      and (1 << 20u) is signed so subtracting 2000000 yields a negative value.
// EXPECT: E:arith and F:neg.
#include <stdio.h>

int main(void) {
#if (-1 >> 1u) == -1
  puts("E:arith");
#else
  puts("E:logic");
#endif
#if (1 << 20u) - 2000000 < 0
  puts("F:neg");
#else
  puts("F:pos");
#endif
  return 0;
}
