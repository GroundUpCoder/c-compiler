#include <stdio.h>

// Labels with no gotos targeting them should be harmless
void test_unused_label() {
  long x = 1;
  x = x + 1;
unused:
  x = x + 2;
  printf("unused_label: %ld\n", x);
}

// Mix of used and unused labels
void test_mixed() {
  goto used;
  printf("SHOULD NOT PRINT\n");
not_targeted:
  printf("after not_targeted\n");
used:
  printf("after used\n");
also_unused:
  printf("after also_unused\n");
}

int main() {
  test_unused_label();
  test_mixed();
  return 0;
}
