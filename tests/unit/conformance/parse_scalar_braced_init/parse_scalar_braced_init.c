// BUG: a braced initializer around a scalar member/object is accepted but the value is dropped (object gets 0).
// C11: 6.7.9p11 -- the initializer for a scalar may be a single expression, optionally enclosed in braces.
// EXPECT: s.a == 5 (braces around the member's scalar initializer), x == 7 (braced scalar initializer).
#include <stdio.h>
struct S1 { int a; };
int main(void) {
  struct S1 s = { {5} };
  int x = {7};
  printf("%d %d\n", s.a, x);
  return 0;
}
