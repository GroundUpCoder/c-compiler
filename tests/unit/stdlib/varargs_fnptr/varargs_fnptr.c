#include <stdarg.h>
#include <stdio.h>

static int sum(int n, ...) {
  va_list ap;
  va_start(ap, n);
  int s = 0;
  for (int i = 0; i < n; i++) s += va_arg(ap, int);
  va_end(ap);
  return s;
}

static double fsum(int n, ...) {
  va_list ap;
  va_start(ap, n);
  double s = 0;
  for (int i = 0; i < n; i++) s += va_arg(ap, double);
  va_end(ap);
  return s;
}

typedef int (*IVarFn)(int, ...);
typedef double (*DVarFn)(int, ...);

int main(void) {
  IVarFn f = sum;
  printf("%d\n", f(3, 10, 20, 30));    // 60
  printf("%d\n", f(1, 42));            // 42
  printf("%d\n", f(4, 1, 2, 3, 4));   // 10

  DVarFn g = fsum;
  printf("%.1f\n", g(2, 1.5, 2.5));   // 4.0

  return 0;
}
