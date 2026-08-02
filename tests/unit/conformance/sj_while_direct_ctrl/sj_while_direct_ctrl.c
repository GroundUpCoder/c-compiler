// BUG: `while (setjmp(b))` — the setjmp invocation directly as the
//      entire controlling expression of an iteration statement — was
//      rejected
// C11: 7.13.1.1p4 (required context). Direct path: setjmp returns 0,
//      the loop body never runs. After a longjmp the body runs once,
//      then the re-evaluated setjmp returns 0 again and the loop exits.
// EXPECT: skipped, body 1, skipped, end fired=1; matches native clang
#include <setjmp.h>
#include <stdio.h>

static jmp_buf b;
static int fired;

int main(void) {
  while (setjmp(b)) {
    printf("body %d\n", fired);
  }
  puts("skipped");
  if (!fired) {
    fired = 1;
    longjmp(b, 3);
  }
  printf("end fired=%d\n", fired);
  return 0;
}
