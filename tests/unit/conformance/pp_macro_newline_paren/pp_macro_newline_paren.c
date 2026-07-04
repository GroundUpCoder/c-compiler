// BUG: a function-like macro invocation whose name and ( are separated by a
//      newline is not expanded — the compiler reports "Undeclared identifier".
// C11: 6.10.3p10 — the macro is invoked when the name is followed by a (,
//      with white space (which includes new-line, 6.10.3p11 / 6.4p3 fn)
//      permitted between them.
// EXPECT: f\n(41) expands to ((41)+1) == 42.
#include <stdio.h>

#define f(x) ((x)+1)

int main(void) {
  printf("%d\n", f
(41));
  return 0;
}
