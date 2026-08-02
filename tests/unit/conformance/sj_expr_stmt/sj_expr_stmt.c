// BUG: `setjmp(b);` / `(void)setjmp(b);` — the entire expression of an
//      expression statement (optionally cast to void) — was rejected
// C11: 7.13.1.1p4 (required context; the return value is discarded by
//      the form, the observable is the resume point)
// EXPECT: hop 0, hop 1, hop 2, void form armed; matches native clang
#include <setjmp.h>
#include <stdio.h>

static jmp_buf b;
static int hops;

int main(void) {
  setjmp(b);
  printf("hop %d\n", hops);
  if (hops++ < 2) longjmp(b, 99);
  (void)setjmp(b);
  puts("void form armed");
  return 0;
}
