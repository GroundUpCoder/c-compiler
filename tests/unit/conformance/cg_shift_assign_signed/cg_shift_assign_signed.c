// BUG: compound assignment >>= on a signed LHS emits a logical (unsigned) shift when the RHS is unsigned
// C11: 6.5.7p3 (result type is the promoted type of the LEFT operand), 6.5.16.2p3 (E1 op= E2 is E1 = E1 op E2)
// EXPECT: signed >> is arithmetic in this implementation (plain `>>` already is), so -8>>1 == -4 and -1>>1 == -1; matches native clang
#include <stdio.h>
int main(void) {
  int i = -8;
  unsigned u = 1;
  i >>= u;
  printf("i=%d\n", i);
  int j = -1;
  j >>= 1u;
  printf("j=%d\n", j);
  long long k = -8;
  k >>= (unsigned long long)1;
  printf("k=%lld\n", k);
  return 0;
}
