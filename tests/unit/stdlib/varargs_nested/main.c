// Test for nested variadic calls.
//
// The compiler uses a single local (vaArgsCallBaseLocalIdx) per function
// to hold the base pointer for variadic argument storage at call sites.
// When a variadic call appears as an argument to another variadic call,
// the inner call overwrites that local, so the outer call passes the
// wrong va_args pointer to the callee.
//
// printf is a JS import and doesn't use C-side va_args, so the bug
// only manifests when BOTH the inner and outer calls are C variadic
// functions.

#include <stdarg.h>
#include <stdio.h>

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
  // ---- Non-nested (store result in a variable first) ----
  int inner = va_sum(2, 10, 20);          // expect 30
  int non_nested = va_sum(2, inner, 100); // expect 130
  printf("non_nested: %d\n", non_nested);

  // ---- Nested (inner variadic result passed directly as vararg) ----
  int nested = va_sum(2, va_sum(2, 10, 20), 100); // expect 130
  printf("nested: %d\n", nested);

  // ---- Nested with multiple varargs after the nested call ----
  int nested2 = va_sum(3, 1, va_sum(2, 10, 20), 1000); // expect 1031
  printf("nested2: %d\n", nested2);

  return 0;
}
