// BUG: emitAssignment computed a compound assignment's operation type from
// the DECLARED lvalue type, so `u20 /= -3` divided unsigned (quotient 0)
// where C requires the promoted (signed int) computation (todos/0367
// residual of 0356).
// C11: 6.5.16.2p3 — E1 op= E2 computes E1 op E2 with the usual arithmetic
// conversions, which begin with the integer promotions (6.3.1.8); the result
// converts back to the lvalue's (bit-field) type on store.
// EXPECT: division/modulo on a narrow unsigned field is signed; an
// exactly-32-bit unsigned field stays unsigned; wrap-around ops unchanged.
#include <stdio.h>

struct S {
  unsigned u20 : 20;
  unsigned u32 : 32;
  unsigned long long ull20 : 20;
};

int main(void) {
  struct S t;

  t.u20 = 1000000;
  t.u20 /= -3;                     /* (int)1000000 / -3 = -333333, masked */
  printf("A1 %u\n", (unsigned)t.u20);
  t.u20 = 7;
  t.u20 %= -3;                     /* 7 % -3 = 1 */
  printf("A2 %u\n", (unsigned)t.u20);
  t.ull20 = 500000;
  t.ull20 /= -5;                   /* (int)500000 / -5 = -100000, masked */
  printf("A3 %u\n", (unsigned)t.ull20);
  /* control: u32 promotes to unsigned int, division stays unsigned */
  t.u32 = 1000000;
  t.u32 /= -3;
  printf("A4 %u\n", (unsigned)t.u32);
  /* control: wrap-around is signedness-blind */
  t.u20 = 0;
  t.u20 -= 1;
  printf("A5 %u\n", (unsigned)t.u20);
  /* shift-compound computes in the promoted LEFT type; value-identical
     for a non-negative narrow field — control */
  t.u20 = 3;
  t.u20 <<= 2;
  printf("A6 %u\n", (unsigned)t.u20);
  /* the bit-field on the RIGHT of a compound assignment promotes too:
     UAC(int, promoted int) keeps the division signed */
  t.u20 = 3;
  {
    int x = -9;
    x /= t.u20;
    printf("A7 %d\n", x);
  }
  return 0;
}
