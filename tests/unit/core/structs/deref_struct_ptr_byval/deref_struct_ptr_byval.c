/* Bug: dereferencing a struct pointer (*ptr) and passing by value
   fails with "emitLoad: unsupported type". */
#include <stdio.h>

struct S { unsigned int x; unsigned int y; };

void print_s(struct S s) {
  printf("x=%u y=%u\n", s.x, s.y);
}

int main() {
  struct S val;
  val.x = 3;
  val.y = 4;
  struct S *ptr = &val;
  print_s(*ptr);
  return 0;
}
