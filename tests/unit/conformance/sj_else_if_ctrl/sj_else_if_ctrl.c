// BUG: `else if (setjmp(b))` — the entire controlling expression of a
//      selection statement in an else branch — was rejected: the
//      lowering never recursed into a non-compound else slot
// C11: 7.13.1.1p4 (required context)
// EXPECT: direct path takes the else, longjmp lands in the else-if's
//         then branch; the (r = setjmp) variant observes the exact
//         value; matches native clang
#include <setjmp.h>
#include <stdio.h>

static jmp_buf b1, b2;
static int r;

int main(void) {
  int cold = 0;
  if (cold) {
    puts("cold");
  } else if (setjmp(b1)) {
    puts("jumped");
  } else {
    puts("armed");
    longjmp(b1, 1);
  }

  if (cold) {
    puts("cold2");
  } else if ((r = setjmp(b2))) {
    printf("caught %d\n", r);
  } else {
    longjmp(b2, 6);
  }
  puts("done");
  return 0;
}
