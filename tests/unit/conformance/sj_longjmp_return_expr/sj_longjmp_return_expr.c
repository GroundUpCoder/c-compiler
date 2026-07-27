// BUG: longjmp() inside a return expression crashed the compiler with an
//      uncaught JS error ("emitExpr: function 'longjmp' not found")
// C11: 7.13.2.1 (longjmp is an ordinary void call, valid in any expression),
//      6.5.17p2 (the left operand of a comma is evaluated as a void
//      expression, with a sequence point before the right operand)
// EXPECT: "pre" prints, then the jump fires before the return value is ever
//         produced; matches native clang
#include <setjmp.h>
#include <stdio.h>

static jmp_buf buf;

static int f(void) {
  return (puts("pre"), longjmp(buf, 5), 0);
}

int main(void) {
  int r;
  if ((r = setjmp(buf))) {
    printf("caught %d\n", r);
    return 0;
  }
  printf("returned %d\n", f());
  return 0;
}
