#include <stdarg.h>
#include <stddef.h>
int sum(int n, ...) {
  va_list ap;
  va_start(ap, n);
  int t = 0;
  for (int i = 0; i < n; i++) t += va_arg(ap, int);
  va_end(ap);
  return t;
}
double dsum(int n, ...) {
  va_list ap;
  va_start(ap, n);
  double t = 0;
  for (int i = 0; i < n; i++) t += va_arg(ap, double);
  va_end(ap);
  return t;
}
int main(void) { return sum(3, 10, 20, 12) + (int)dsum(2, 1.5, 2.5); }
