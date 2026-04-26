// Test returning a struct from a variadic function.
#include <stdio.h>
#include <stdarg.h>

struct Point { int x; int y; };

struct Point make_point(int n, ...) {
  va_list ap;
  va_start(ap, n);
  struct Point p;
  p.x = va_arg(ap, int);
  p.y = va_arg(ap, int);
  va_end(ap);
  return p;
}

int main() {
  struct Point p = make_point(0, 10, 20);
  printf("Point(%d, %d)\n", p.x, p.y);

  struct Point q = make_point(0, 100, 200);
  printf("Point(%d, %d)\n", q.x, q.y);

  return 0;
}
