// BUG: an unsigned bit-field narrower than int is treated as unsigned int in expressions, so s.bf > -1 becomes an unsigned comparison (0 > 0xFFFFFFFF -> 0).
// C11: 6.3.1.1p2 -- a bit-field of type unsigned int whose value range fits in int promotes to (signed) int.
// EXPECT: (int)0 > -1 is a signed comparison -> 1.
#include <stdio.h>
int main(void) {
  struct { unsigned bf:3; } s = {0};
  printf("%d\n", s.bf > -1);
  return 0;
}
