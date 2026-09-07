// BUG: #432 rejected valid nonzero integer constant comparisons.
// C11: 7.13.1.1p4 permits relational/equality against an integer constant expression.
// EXPECT: each test resumes with the longjmp value and uses normal C conversions.
#include <setjmp.h>
#include <stdio.h>
static jmp_buf b;
static int phase;
#define CHECK(expr, jump) do { phase=0; if (expr) { if (!phase) { phase=1; longjmp(b,jump); } puts("true"); } else { if (!phase) { phase=1; longjmp(b,jump); } puts("false"); } } while(0)
int main(void) {
  enum { TWO=2 };
  CHECK(setjmp(b) == TWO, 2);
  CHECK((1+1) != setjmp(b), 2);
  CHECK(setjmp(b) < 3, 2);
  CHECK(3 <= setjmp(b), 4);
  CHECK(setjmp(b) > -1, -2);
  CHECK(2 >= setjmp(b), 3);
  CHECK(setjmp(b) < 1U, -1);
  CHECK(setjmp(b) == sizeof(char), 0);
  CHECK(setjmp(b) == (long long)2, 2);
  return 0;
}
