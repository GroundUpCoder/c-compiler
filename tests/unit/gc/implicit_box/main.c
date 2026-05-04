#include <stdio.h>

__struct Point { int x; int y; };

void describe(__eqref x) {
  if (__ref_test(__struct Point *, x)) {
    __struct Point *p = __cast(__struct Point *, x);
    printf("point %d %d\n", p->x, p->y);
  } else {
    printf("primitive\n");
  }
}

__eqref doubled(int n) {
  return n * 2;   // implicit box on return
}

int main(void) {
  // implicit boxing as call argument
  describe(42);                                  // boxes int
  describe(3.14);                                // boxes double
  describe(__new(__struct Point *, 1, 2));       // upcast Point* → __eqref (no box)

  // implicit boxing on assignment / init
  __eqref e = 100;                               // boxes 100
  printf("e: %d\n", __cast(int, e));

  // 0 / NULL still mean null (don't box)
  __eqref n1 = 0;
  __eqref n2 = NULL;
  __eqref n3;                                    // auto-null
  printf("nulls: %d %d %d\n", n1 == 0, n2 == 0, n3 == 0);

  // Explicit boxed zero is distinct from null
  __eqref boxed_zero = __cast(__eqref, 0);
  printf("boxed_zero null: %d  unboxed: %d\n", boxed_zero == 0, __cast(int, boxed_zero));

  // Reassignment auto-boxes
  e = 999;
  printf("e: %d\n", __cast(int, e));

  // Implicit boxing on return
  __eqref r = doubled(21);
  printf("returned: %d\n", __cast(int, r));

  // Implicit boxing for various primitive types
  __eqref ll = 1234567890123LL;                  // i64 box
  __eqref f = 2.5f;                              // f32 box
  __eqref d = 1.5;                               // f64 box
  printf("%lld %g %g\n",
         __cast(long long, ll),
         (double)__cast(float, f),
         __cast(double, d));

  // GC ref → __eqref (subtype upcast — already worked before, kept here)
  __struct Point *p = __new(__struct Point *, 5, 10);
  __eqref ep = p;                                // implicit upcast
  __struct Point *p2 = __cast(__struct Point *, ep);
  printf("identity: %d\n", p == p2);

  // Explicit non-zero int → typed ref still rejected (only __eqref auto-boxes)
  // (verified by gc/err_ref_nonzero_init)

  return 0;
}
