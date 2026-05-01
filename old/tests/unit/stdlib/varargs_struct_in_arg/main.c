// Test that a struct-returning call inside a variadic argument expression
// doesn't corrupt the varargs base pointer.
//
// A struct-returning call increments structRetDeferred (the SP is not
// restored until the outermost call completes).  The varargs reload
// must account for this delta so the outer va_args pointer stays correct.

#include <stdarg.h>
#include <stdio.h>

struct Point {
  int x;
  int y;
};

struct Point make_point(int x, int y) {
  struct Point p;
  p.x = x;
  p.y = y;
  return p;
}

int va_sum(int count, ...) {
  va_list ap;
  va_start(ap, count);
  int total = 0;
  for (int i = 0; i < count; i++) {
    total = total + va_arg(ap, int);
  }
  va_end(ap);
  return total;
}

int main() {
  // Struct-returning call as subexpression of a vararg
  int r1 = va_sum(2, make_point(10, 20).x, 100);
  printf("r1: %d\n", r1);  // 110

  // Struct return in a later vararg slot
  int r2 = va_sum(3, 1, make_point(30, 40).y, 1000);
  printf("r2: %d\n", r2);  // 1041

  // Two struct-returning calls in separate vararg slots
  int r3 = va_sum(2, make_point(5, 6).x, make_point(7, 8).y);
  printf("r3: %d\n", r3);  // 13

  // Mix: nested variadic call + struct return in the same outer call
  int r4 = va_sum(3, make_point(2, 3).x, va_sum(2, 10, 20), 1000);
  printf("r4: %d\n", r4);  // 1032

  return 0;
}
