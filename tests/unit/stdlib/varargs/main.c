#include <stdarg.h>
#include <stdio.h>

int get_first(int dummy, ...) {
  va_list ap;
  va_start(ap, dummy);
  int val = va_arg(ap, int);
  va_end(ap);
  return val;
}

int sum2(int count, ...) {
  va_list ap;
  va_start(ap, count);
  int a = va_arg(ap, int);
  int b = va_arg(ap, int);
  va_end(ap);
  return a + b;
}

int sum(int count, ...) {
  va_list ap;
  va_start(ap, count);
  int total = 0;
  for (int i = 0; i < count; i++) {
    total = total + va_arg(ap, int);
  }
  va_end(ap);
  return total;
}

int debug_va(int count, ...) {
  va_list ap;
  va_start(ap, count);
  int a = va_arg(ap, int);
  int b = va_arg(ap, int);
  va_end(ap);
  return a + b;
}

int main() {
  printf("get_first: %d\n", get_first(0, 42));       // 42
  printf("sum2: %d\n", sum2(2, 10, 20));              // 30
  printf("sum: %d\n", sum(3, 10, 20, 30));            // 60
  printf("debug_va: %d\n", debug_va(2, 100, 200));    // 300
  return 0;
}
