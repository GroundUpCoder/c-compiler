// BUG: longjmp() in a for-statement increment clause crashed the compiler with
//      an uncaught JS error ("emitExpr: function 'longjmp' not found")
// C11: 7.13.2.1 (longjmp is an ordinary void call, valid in any expression),
//      6.8.5.3 (the third clause of a for is evaluated as a void expression
//      after each execution of the loop body)
// EXPECT: the body runs once, then the increment jumps; matches native clang
#include <setjmp.h>
#include <stdio.h>

static jmp_buf buf;

int main(void) {
  int r;
  if ((r = setjmp(buf))) {
    printf("caught %d\n", r);
    return 0;
  }
  for (int i = 0; i < 3; i++, longjmp(buf, 7)) {
    printf("body %d\n", i);
  }
  puts("not reached");
  return 0;
}
