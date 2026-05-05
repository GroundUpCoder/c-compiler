#include <stdio.h>

// Strict __ref_cast traps on null. Use __ref_cast_null (or __cast(T, x))
// when null pass-through is desired.
__struct Foo { int x; };

int main(void) {
  __eqref e = 0;
  __struct Foo *p = __ref_cast(__struct Foo *, e);
  printf("UNREACHABLE x=%d\n", p->x);
  return 0;
}
