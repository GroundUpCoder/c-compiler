// A function with a ref-typed return that has paths missing a `return` —
// the implicit fallthrough must emit `ref.null`, not `i32.const 0`. Test
// covers both abstract heap (eqref) and externref.
#include <stdio.h>

__eqref get_eq(int n) {
  if (n > 0) return n;
  // missing return — implicit ref.null eq
}

__externref get_ex(int n) {
  if (n > 0) return 0;
  // missing return — implicit ref.null extern
}

int main(void) {
  __eqref e1 = get_eq(5);
  __eqref e2 = get_eq(-1);
  printf("e1=%d e2=%s\n", __cast(int, e1), e2 == 0 ? "null" : "set");

  __externref x1 = get_ex(5);
  __externref x2 = get_ex(-1);
  printf("x1=%s x2=%s\n", x1 == 0 ? "null" : "set", x2 == 0 ? "null" : "set");

  return 0;
}
