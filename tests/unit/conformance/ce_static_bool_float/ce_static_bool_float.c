// BUG: the static initializer converts 0.5 to _Bool by truncating to an
//      integer first (0.5 -> 0), so sb is 0.
// C11: 6.3.1.2p1 — when any scalar value is converted to _Bool, the result
//      is 1 iff the value compares unequal to 0; 0.5 != 0, so sb must be 1.
// EXPECT: prints 1 (the runtime conversion already gets this right; the
//         static-storage constant path does not).
#include <stdio.h>

static _Bool sb = 0.5;

int main(void) {
  printf("%d\n", (int)sb);
  return 0;
}
