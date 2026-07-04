// BUG: longjmp back to a setjmp whose result is only tested by a preceding if (retry loop pattern) aborts the program (Fatal: undefined) instead of resuming after setjmp
// C11: 7.13.2.1p3-p5 (longjmp restores the environment; execution continues as if setjmp had just returned its second argument; objects that changed are volatile-qualified here so their values are defined)
// EXPECT: the retry loop runs with n = 0,1,2,3 then prints done; the else-variant longjmps once and takes the else arm; matches native clang
#include <setjmp.h>
#include <stdio.h>

jmp_buf buf;
volatile int n = 0;

jmp_buf buf2;
volatile int m = 0;

int main(void) {
  if (setjmp(buf) == 0) {
    puts("setup");
  }
  printf("n=%d\n", n);
  if (n < 3) {
    n++;
    longjmp(buf, 1);
  }
  puts("done");

  if (setjmp(buf2) == 0) {
    puts("first");
    m++;
    longjmp(buf2, 1);
  } else {
    puts("back");
  }
  puts("end");
  return 0;
}
