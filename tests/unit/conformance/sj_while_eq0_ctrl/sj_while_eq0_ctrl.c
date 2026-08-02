// BUG: `while (setjmp(b) == 0)` — equality against an integer constant
//      expression as the entire controlling expression of an iteration
//      statement — was rejected, while the diagnostic advertised the
//      identical comparison in if-position as supported
// C11: 7.13.1.1p4 (required context), 7.13.2.1 (longjmp returns to the
//      most recent setjmp evaluation: the controlling expression)
// EXPECT: the loop iterates normally (re-arming each pass), exits via
//         the jump path, and the (r = setjmp(b)) variant observes the
//         exact longjmp value; matches native clang
#include <setjmp.h>
#include <stdio.h>

static jmp_buf b;
static int n;

int main(void) {
  while (setjmp(b) == 0) {
    printf("pass %d\n", n);
    n++;
    if (n == 3) longjmp(b, 42);
  }
  printf("after n=%d\n", n);

  int r = 0;
  while ((r = setjmp(b)) == 0) {
    puts("armed2");
    longjmp(b, 9);
  }
  printf("caught %d\n", r);
  return 0;
}
