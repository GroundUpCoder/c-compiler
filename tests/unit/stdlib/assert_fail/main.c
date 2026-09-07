#include <assert.h>
#include <stdio.h>

int main() {
  printf("About to fail...\n");
  assert(1 == 2);
  printf("Should not reach here\n");
  return 0;
}

// The assertion message plus dynamic abort backtrace is checked against this
// fixture by tests/host/test_abort_backtrace.js (#760).
