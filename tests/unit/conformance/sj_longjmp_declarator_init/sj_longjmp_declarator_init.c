// BUG: longjmp() inside a declarator's initializer crashed the compiler with
//      an uncaught JS error ("emitExpr: function 'longjmp' not found") — the
//      initializer is an expression slot on the DVar, not a statement
// C11: 7.13.2.1 (longjmp is an ordinary void call, valid in any expression),
//      6.5.17p2 (comma), 6.7.9p11 (the initializer of a scalar is an
//      assignment expression)
// EXPECT: the jump fires while evaluating the initializer, so the object is
//         never initialized and nothing after it runs; matches native clang
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
  int x = (flag ? longjmp(buf, 1) : longjmp(buf, 9), 42);
  printf("not reached %d\n", x);
  return 0;
}
