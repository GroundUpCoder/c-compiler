// BUG: unsuffixed decimal constants that exceed 32 bits are truncated in #if,
//      so 4000000000 becomes negative and compares less than -1.
// C11: 6.4.4.1p5 — an unsuffixed decimal constant is of a signed type; in #if
//      (6.10.1p4) it has type intmax_t, so 4000000000 and 5000000000 stay
//      positive signed values, and the comparison with -1 is signed.
// EXPECT: both comparisons are true -> "1 1".
#include <stdio.h>

#if 5000000000 > -1
#define P 1
#else
#define P 2
#endif
#if 4000000000 > -1
#define Q 1
#else
#define Q 2
#endif

int main(void) {
  printf("%d %d\n", P, Q);
  return 0;
}
