// BUG guard: `r = setjmp(b);` as a plain assignment statement is NOT in
//      C11 7.13.1.1p4's context list — it is UB — and must STAY rejected
//      after the p4-required contexts were accepted (ticket #117 /
//      todos/0311). A future widening that legalises it must fail here.
// C11: 7.13.1.1p4 (context list does not include assignment statements)
#include <setjmp.h>

static jmp_buf b;

int main(void) {
  int r;
  r = setjmp(b);
  return r;
}
