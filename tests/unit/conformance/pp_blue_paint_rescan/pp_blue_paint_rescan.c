// BUG: the macro name produced by its own expansion is re-expanded (blue
//      paint / no-rescan marking is missing), so f(3)(4) mis-expands and the
//      compiler rejects the program with a type error.
// C11: 6.10.3.4p2 — the name of the macro being replaced is not replaced
//      again during rescanning: f(3) -> `3*2 + f`, and that trailing `f`
//      (now followed by `(4)` from the source) refers to the real function.
// EXPECT: f(3)(4) -> 3*2 + f(4) == 6 + 4 == 10.
#include <stdio.h>

#define f(x) x*2 + f

int (f)(int y) { return y; }

int main(void) {
  printf("%d\n", f(3)(4));
  return 0;
}
