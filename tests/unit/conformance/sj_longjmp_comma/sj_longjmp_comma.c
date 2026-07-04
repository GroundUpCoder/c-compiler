// BUG: side effects of the left operand of a comma expression whose right operand is longjmp() are dropped
// C11: 6.5.17p2 (left operand of comma is evaluated as a void expression; there is a sequence point before the right operand), 7.13.2.1 (longjmp)
// EXPECT: "cleanup" must be printed before the jump, then setjmp returns 1 and "caught" is printed; matches native clang
#include <setjmp.h>
#include <stdio.h>

jmp_buf buf;

void f(void) {
  (puts("cleanup"), longjmp(buf, 1));
}

int main(void) {
  if (setjmp(buf) == 0) {
    f();
    puts("not reached");
  } else {
    puts("caught");
  }
  return 0;
}
