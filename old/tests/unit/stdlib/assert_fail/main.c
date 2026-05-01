#include <assert.h>
#include <stdio.h>

int main() {
  printf("About to fail...\n");
  assert(1 == 2);
  printf("Should not reach here\n");
  return 0;
}
