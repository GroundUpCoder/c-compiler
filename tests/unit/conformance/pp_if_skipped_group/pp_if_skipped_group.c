// BUG: directives inside a skipped (#if 0) group are fully evaluated, so an
//      inner "#if 1/0" crashes the compiler even though the group is skipped.
// C11: 6.10p1 (group semantics) and 6.10.1p6 — within a skipped group, only
//      the directive names matter for tracking nesting; the constant
//      expressions of nested conditionals in skipped groups are not evaluated.
// EXPECT: the whole #if 0 group is skipped and the program prints "ok".
#include <stdio.h>

#if 0
#if 1/0
#endif
#endif

int main(void) {
  printf("ok\n");
  return 0;
}
