// Test va_copy: copy a va_list and iterate both independently.
//
// NOTE: This test currently FAILS because of the for-loop scoping bug
// (tests/unit/control_flow/for_loop_scoping), not because of va_copy
// itself.  The two `for (int i = ...)` loops share the same WASM local,
// so the second loop never executes.  Once the scoping bug is fixed,
// this test should pass without any changes to the va_copy codegen.

#include <stdarg.h>
#include <stdio.h>

int sum_twice(int count, ...) {
  va_list ap1;
  va_list ap2;
  va_start(ap1, count);
  va_copy(ap2, ap1);

  int sum1 = 0;
  for (int i = 0; i < count; i++) {
    sum1 += va_arg(ap1, int);
  }
  va_end(ap1);

  int sum2 = 0;
  for (int i = 0; i < count; i++) {
    sum2 += va_arg(ap2, int);
  }
  va_end(ap2);

  return sum1 + sum2;
}

// Copy after partial iteration — ap2 should start where ap1 left off.
int copy_after_one(int count, ...) {
  va_list ap1;
  va_list ap2;
  va_start(ap1, count);

  int first = va_arg(ap1, int);
  va_copy(ap2, ap1);   // ap2 starts at second arg

  int rest1 = 0;
  for (int j = 1; j < count; j++) {
    rest1 += va_arg(ap1, int);
  }
  va_end(ap1);

  int rest2 = 0;
  for (int k = 1; k < count; k++) {
    rest2 += va_arg(ap2, int);
  }
  va_end(ap2);

  return first + rest1 + rest2;
}

int main() {
  printf("sum_twice: %d\n", sum_twice(3, 5, 10, 15));       // expect 60
  printf("copy_after_one: %d\n", copy_after_one(3, 5, 10, 15));  // expect 55
  return 0;
}
