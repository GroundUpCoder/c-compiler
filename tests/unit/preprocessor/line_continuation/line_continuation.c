#include <stdio.h>

#define GREETING "hello \
world"

#define ADD(a, b) \
  ((a) + (b))

int main() {
  printf("%s\n", GREETING);
  printf("%d\n", ADD(10, 20));
  return 0;
}
