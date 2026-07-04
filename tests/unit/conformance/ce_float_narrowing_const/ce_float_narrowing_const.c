// BUG: constant evaluation ignores narrowing casts to float (and value
//      truncation to double), keeping full precision: it prints 2000000001,
//      9007199254740993 and 0 instead of the correctly-narrowed values.
// C11: 6.3.1.4p2 — conversion of an integer to a real floating type picks the
//      nearest representable value; float has a 24-bit significand, so
//      (float)2000000001 == 2000000000.0f and (float)16777217 == 16777216.0f;
//      double has a 53-bit significand, so (double)9007199254740993 ==
//      9007199254740992.0.
// EXPECT: 2000000000, 9007199254740992, 1 (verified against native clang).
#include <stdio.h>

static int q = ((float)16777217 == 16777216.0f);

int main(void) {
  printf("%d\n", (int)(float)2000000001);
  printf("%lld\n", (long long)(double)9007199254740993LL);
  printf("%d\n", q);
  return 0;
}
