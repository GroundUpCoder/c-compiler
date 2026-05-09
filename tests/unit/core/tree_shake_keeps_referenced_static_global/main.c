// Static global referenced by a live function must NOT be dropped.
// Sanity check that the bag walk surfaces variable references.

#include <stdio.h>

static int counter = 41;

int main(void) {
  counter = counter + 1;
  printf("%d\n", counter);  // 42
  return 0;
}
