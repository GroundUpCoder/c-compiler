// Static-global chain via address-take: live_root references mid via
// its initializer; mid references leaf. Reading live_root must reach
// all three. Tree-shake should keep the whole chain alive.

#include <stdio.h>

static int leaf = 100;
static int *mid = &leaf;
static int **live_root = &mid;

int main(void) {
  printf("%d\n", **live_root);  // 100
  return 0;
}
