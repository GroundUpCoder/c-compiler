// BUG: two defects around bit-field-ness carried through value-forwarding
// expressions (todos/0367 residual of 0356). (1) promoteExprType promoted the
// LEFT operand of an assignment when computing the assignment's own result
// type, so `(t.ull20 = 5)` was typed (promoted) int while codegen reloaded
// the stored field at its declared 64-bit width — consuming it in arithmetic
// emitted INVALID WASM (i32.sub over an i64 reload; pre-existing ICE, 0356's
// parent fails identically). (2) the promotion recognizer saw only a direct
// member access, but clang (the oracle) tracks the source bit-field through
// assignment results, compound-assignment results, the comma operator's last
// operand, and PRE-inc/dec — so -(t.u20 = 0xFFFFF) < 0 was 0 for us, 1 for
// clang. POST-inc/dec results deliberately do NOT carry bit-field-ness
// (clang-pinned: I3).
// C11: 6.5.16p3 — an assignment expression has the type the left operand
// would have after lvalue conversion (NOT the promoted type); 6.3.1.1p2 —
// the integer promotions then apply where the result is consumed as a
// bit-field value.
// EXPECT: clang-identical signedness through every carrier form; the
// ull20 assignment-result case compiles and runs (no ICE).
#include <stdio.h>

struct S {
  unsigned u20 : 20;
  unsigned long long ull20 : 20;
};

int main(void) {
  struct S t;

  t.u20 = 0;
  printf("B1 %d\n", -(t.u20 = 0xFFFFF) < 0);          /* assignment result */
  printf("B2 %d\n", -(t.u20 += 0) < 0);               /* compound result */
  printf("B3 %d\n", -((void)0, t.u20) < 0);           /* comma last operand */
  printf("B4 %d\n", (t.u20 = 0xFFFFF) - 0x200000 < 0);/* binary consumption */
  t.u20 = 5;
  printf("B5 %d\n", -(--t.u20) < 0);                  /* pre-dec carries */
  t.ull20 = 5;
  printf("B6 %d\n", (t.ull20 = 5) - 100 < 0);         /* the ICE shape */
  printf("B7 %d\n", -(t.ull20 = 3, t.ull20) < 0);     /* comma + wide-declared */

  /* pre-inc carries; post-inc/dec do NOT (clang-pinned) */
  t.u20 = 5;
  printf("I1 %d\n", -(++t.u20) < 0);
  t.u20 = 1;
  printf("I2 %d\n", -(t.u20++) < 0);
  t.ull20 = 5;
  printf("I3 %d\n", (t.ull20++) - 100 < 0);
  return 0;
}
