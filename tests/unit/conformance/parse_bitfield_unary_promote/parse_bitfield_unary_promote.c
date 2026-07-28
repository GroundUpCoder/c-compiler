// BUG: makeUnary computed the result type from the UNPROMOTED declared type
// (computeUnaryType only promotes size < 4), so -bf/~bf/+bf on a narrow
// unsigned bit-field stayed unsigned: (-s.u20) < 0 was 0, and
// (unsigned long long)~s.u20 zero-extended (todos/0367 — the "unary was
// already correct" claim in 0356's record was false).
// C11: 6.3.1.1p2 + 6.5.3.3 — the integer promotions apply to the operand of
// unary +, -, ~; a bit-field whose values int can represent (width < 32, or
// signed width 32) promotes to (signed) int, wider fields keep the declared
// type.
// EXPECT: the unary result is signed for every narrow field (declared type
// irrelevant); exactly-32-bit unsigned and wider-than-int fields keep
// unsigned/declared semantics.
#include <stdio.h>

struct S {
  unsigned u20 : 20;             /* promotes to int */
  int s10 : 10;                  /* promotes to int */
  unsigned u32 : 32;             /* promotes to unsigned int */
  long long ll20 : 20;           /* narrow field of wide type: promotes to int */
  unsigned long long ull20 : 20; /* narrow field of wide type: promotes to int */
  long long sll40 : 40;          /* wider than int: keeps long long */
  unsigned long long ull40 : 40; /* wider than int: keeps unsigned long long */
};

int main(void) {
  struct S t;
  struct S *p = &t;

  t.u20 = 0xFFFFF;
  printf("U1 %d\n", -t.u20 < 0);
  printf("U2 %llx\n", (unsigned long long)-t.u20);
  printf("U3 %llx\n", (unsigned long long)~t.u20);
  printf("U4 %d\n", ~t.u20 < 0);
  printf("U5 %d\n", (+t.u20) - 0x200000 < 0);
  printf("U6 %d\n", ~p->u20 < 0);              /* EArrow path */

  t.ull20 = 0;
  printf("U7 %d\n", ~t.ull20 < 0);
  t.ll20 = 5;
  printf("U8 %d\n", -t.ll20 < 0);
  t.ull20 = 3;
  printf("U9 %llx\n", (unsigned long long)-t.ull20);

  /* controls: no behavior change owed */
  t.u32 = 1;
  printf("C1 %d\n", -t.u32 < 0);
  t.s10 = -1;
  printf("C2 %d\n", -t.s10 < 0);
  t.ull40 = 1;
  printf("C3 %d\n", -t.ull40 < 0);
  t.sll40 = 5;
  printf("C4 %d\n", -t.sll40 < 0);
  t.u20 = 0xFFFFF;
  printf("C5 %llx\n", (unsigned long long)(t.u20 << 12));
  return 0;
}
