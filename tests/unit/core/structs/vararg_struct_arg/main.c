// Test passing a struct as a variadic argument.
#include <stdio.h>
#include <stdarg.h>

struct Point { int x; int y; };

void print_point(int n, ...) {
  va_list ap;
  va_start(ap, n);
  for (int i = 0; i < n; i++) {
    struct Point p = va_arg(ap, struct Point);
    printf("Point(%d, %d)\n", p.x, p.y);
  }
  va_end(ap);
}

int main() {
  struct Point p;
  p.x = 1;
  p.y = 2;
  print_point(1, p);

  struct Point q;
  q.x = 10;
  q.y = 20;
  print_point(2, p, q);

  return 0;
}
