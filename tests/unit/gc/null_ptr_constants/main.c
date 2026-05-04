// Verifies that 0 / NULL / (refT)0 act as the null pointer constant in
// every context where ref types appear, and don't accidentally trigger
// implicit boxing into a non-null eqref.
#include <stdio.h>

__struct Foo { int x; };

int main(void) {
  // 1. __new_array(__eqref, ..., 0, ...) — 0 should be null, not boxed-zero
  __array(__eqref) a = __new_array(__eqref,
      __cast(__eqref, 1),
      0,
      __cast(__eqref, 3));
  printf("a[0]=%s a[1]=%s a[2]=%s\n",
    a[0] == 0 ? "null" : "set",
    a[1] == 0 ? "null" : "set",
    a[2] == 0 ? "null" : "set");

  // 2. __new(__struct Box *, 0) — boxing a struct field of type __eqref
  //    should treat 0 as null
  __struct Box { __eqref e; };
  __struct Box *b = __new(__struct Box *, 0);
  printf("b.e=%s\n", b->e == 0 ? "null" : "set");

  // 3. C-style cast (refT)0 — typed null
  __struct Foo *p = (__struct Foo *)0;
  __struct Foo *q = (__struct Foo *)NULL;
  printf("p=%s q=%s\n",
    p == 0 ? "null" : "set",
    q == 0 ? "null" : "set");

  // 4. ternary `cond ? refExpr : 0` — the 0 branch is typed null
  int cond = 0;
  __struct Foo *r = cond ? __new(__struct Foo *, 99) : (__struct Foo *)0;
  printf("ternary: %s\n", r == 0 ? "null" : "set");

  // 5. ternary `cond ? refExpr : 0` with raw 0 (should also work)
  __struct Foo *r2 = cond ? __new(__struct Foo *, 99) : 0;
  printf("ternary2: %s\n", r2 == 0 ? "null" : "set");

  // 6. ternary picking the non-null branch
  cond = 1;
  __struct Foo *r3 = cond ? __new(__struct Foo *, 7) : 0;
  printf("ternary3: %d\n", r3->x);

  return 0;
}
