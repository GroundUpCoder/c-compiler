// BUG: `switch (setjmp(b))` — the entire controlling expression of a
//      selection statement — was rejected ("unsupported use of setjmp")
// C11: 7.13.1.1p4 (required context), 7.13.2.1p4 (longjmp with val 0
//      makes setjmp return 1)
// EXPECT: N-way dispatch on the setjmp value across two longjmps,
//         including the 0 -> 1 coercion; matches native clang
#include <setjmp.h>
#include <stdio.h>

static jmp_buf b;

int main(void) {
  switch (setjmp(b)) {
  case 0:
    puts("armed");
    longjmp(b, 7);
  case 1:
    puts("coerced one");
    break;
  case 7:
    puts("seven");
    longjmp(b, 0);
  default:
    puts("unexpected");
  }
  puts("done");
  return 0;
}
