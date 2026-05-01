// Tests initializing a local char array from a string literal.
// e.g. char buf[] = "hello";
// This is distinct from char *p = "hello" (pointer to static string).
#include <stdio.h>

int main() {
  char buf[] = "hello";
  printf("%s\n", buf);

  // Mutate to prove it's a local copy, not a static string
  buf[0] = 'H';
  printf("%s\n", buf);

  char buf2[6] = "world";
  printf("%s\n", buf2);

  return 0;
}
