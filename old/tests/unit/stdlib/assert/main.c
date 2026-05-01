#include <assert.h>
#include <stdio.h>

int main() {
  // These should pass
  assert(1);
  assert(2 + 2 == 4);
  assert(42);

  printf("All assertions passed!\n");

  // This should fail and trap
  // Uncomment to test failure:
  // assert(0);

  return 0;
}
