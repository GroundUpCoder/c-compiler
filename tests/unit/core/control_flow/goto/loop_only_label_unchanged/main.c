// A LOOP-only label (only backward gotos, no forward) is the standard
// "loop emulation" idiom. The codegen handles it via wasm `loop` blocks.
// The inliner must NOT touch LOOP-only labels.
#include <stdio.h>

int countdown(int n) {
  int sum = 0;
  int i = n;
top:
  if (i <= 0) return sum;
  sum += i;
  i--;
  goto top;
}

int main(void) {
  printf("%d\n", countdown(5));   /* 5+4+3+2+1 = 15 */
  printf("%d\n", countdown(0));   /* 0 */
  return 0;
}
