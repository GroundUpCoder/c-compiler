// Static-local function-pointer table — diverted out of the function
// body into staticLocals, so tree-shake's body-bag walk would miss
// the references unless we walk staticLocals explicitly.
// Mirrors Lua's createsearcherstable / searchers[] dispatch pattern.

#include <stdio.h>

static int handler_a(int x) { return x + 1; }
static int handler_b(int x) { return x + 2; }
static int handler_c(int x) { return x + 4; }

typedef int (*handler)(int);

int dispatch(int which, int x) {
  static const handler table[] = { handler_a, handler_b, handler_c };
  return table[which](x);
}

int main(void) {
  printf("%d\n", dispatch(0, 10));  // 11
  printf("%d\n", dispatch(1, 10));  // 12
  printf("%d\n", dispatch(2, 10));  // 14
  return 0;
}
