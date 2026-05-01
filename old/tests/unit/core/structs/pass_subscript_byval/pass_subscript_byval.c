/* Pre-existing bug: passing arr[i] (struct via array subscript) by value
   to a function fails with "emitLoad: unsupported type". */
#include <stdio.h>

struct S { unsigned int x; unsigned int y; };

void print_s(struct S s) {
  printf("x=%u y=%u\n", s.x, s.y);
}

int main() {
  struct S arr[1];
  arr[0].x = 1;
  arr[0].y = 2;
  print_s(arr[0]);
  return 0;
}
