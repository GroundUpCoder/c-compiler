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
  phase=0;
  while(setjmp(b)<3) { phase++; if(phase==1) longjmp(b,2); longjmp(b,3); }
  printf("while=%d\n",phase);
  phase=0;
  switch(setjmp(b)==2) {
    case 0: phase++; longjmp(b,2);
    case 1: printf("switch=%d\n",phase); break;
  }
  return 0;
}
