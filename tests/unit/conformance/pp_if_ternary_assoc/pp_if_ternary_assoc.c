// BUG: the #if expression parser associates the conditional operator wrongly,
//      evaluating 1 ? 0 : 1 ? 2 : 3 as truthy and picking the #if branch (111).
// C11: 6.5.15 (conditional operator grammar) — ?: is right-associative:
//      1 ? 0 : (1 ? 2 : 3) evaluates to 0, which is false.
// EXPECT: the #else branch is taken, so V is 222.
#include <stdio.h>

#if 1 ? 0 : 1 ? 2 : 3
#define V 111
#else
#define V 222
#endif

int main(void) {
  printf("%d\n", V);
  return 0;
}
