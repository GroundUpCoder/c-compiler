// BUG: longjmp() in a conditional-expression arm crashed the compiler with an
//      uncaught JS error ("emitExpr: function 'longjmp' not found") — no file,
//      no line, no diagnostic
// C11: 7.13.2.1 (longjmp carries no context restriction — unlike setjmp's
//      7.13.1.1p4 list, it is an ordinary void call valid in any expression),
//      6.5.15p3 (both arms void => the conditional expression is void)
// EXPECT: the taken arm jumps with its own value; matches native clang
#include <setjmp.h>
#include <stdio.h>

static jmp_buf buf;
static int flag;

int main(void) {
  int r;
  if ((r = setjmp(buf))) {
    printf("caught %d\n", r);
    return 0;
  }
  flag = 0;
  flag ? longjmp(buf, 1) : longjmp(buf, 2);
  puts("not reached");
  return 0;
}
