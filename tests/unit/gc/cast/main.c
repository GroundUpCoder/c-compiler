#include <stdio.h>

__struct Point { int x; int y; };
__struct Color { int r; int g; int b; };

void test_box_unbox(void) {
  printf("=== box/unbox ===\n");
  __eqref a = __cast(__eqref, 42);
  printf("int: %d\n", __cast(int, a));

  __eqref f = __cast(__eqref, 3.14f);
  printf("float: %g\n", (double)__cast(float, f));

  __eqref d = __cast(__eqref, 3.14);
  printf("double: %g\n", __cast(double, d));

  __eqref ll = __cast(__eqref, 1234567890123LL);
  printf("longlong: %lld\n", __cast(long long, ll));

  // Boxed values are independent allocations. == on __eqref does identity
  // comparison (ref.eq) — two boxes with the same contents are NOT identical.
  __eqref a1 = __cast(__eqref, 10);
  __eqref a2 = __cast(__eqref, 10);
  printf("box identity: %d\n", a1 == a2);                              // 0 (different allocs)
  printf("box ints equal: %d\n", __cast(int, a1) == __cast(int, a2));  // 1 (unboxed values match)
}

void test_gc_ref_via_anyref(void) {
  printf("=== gc ref via anyref ===\n");
  __struct Point *p = __new(__struct Point *, 7, 11);
  __eqref ap = __cast(__eqref, p);          // upcast (no-op)
  __struct Point *p2 = __cast(__struct Point *, ap);  // downcast (ref.cast)
  printf("recovered: %d %d\n", p2->x, p2->y);
  printf("identity: %d\n", p == p2);           // 1 (same ref)
}

void test_discriminated_union(void) {
  printf("=== discriminated union ===\n");
  __struct Point *p = __new(__struct Point *, 1, 2);
  __struct Color *c = __new(__struct Color *, 255, 128, 0);

  for (int i = 0; i < 4; i++) {
    __eqref store;
    if (i == 0) store = __cast(__eqref, 99);
    else if (i == 1) store = __cast(__eqref, p);
    else if (i == 2) store = __cast(__eqref, c);
    else store = __cast(__eqref, 2.5);

    if (__ref_test(__struct Point *, store)) {
      __struct Point *q = __cast(__struct Point *, store);
      printf("point: (%d,%d)\n", q->x, q->y);
    } else if (__ref_test(__struct Color *, store)) {
      __struct Color *col = __cast(__struct Color *, store);
      printf("color: (%d,%d,%d)\n", col->r, col->g, col->b);
    } else {
      // Could be int, double, or any other shape — we don't introspect
      printf("primitive\n");
    }
  }
}

void test_extern_bridge(void) {
  printf("=== extern bridge ===\n");
  __struct Point *p = __new(__struct Point *, 5, 10);

  // GC → extern → anyref → GC (full round trip)
  __externref e = __cast(__externref, p);
  __eqref a = __cast(__eqref, e);
  __struct Point *p2 = __cast(__struct Point *, a);
  printf("round-trip: %d %d\n", p2->x, p2->y);
  printf("identity preserved: %d\n", p == p2);
}

void test_numeric(void) {
  printf("=== numeric ===\n");
  // __cast also handles plain numeric conversion
  int i = __cast(int, 3.7);            // 3 (truncate)
  double d = __cast(double, 5);        // 5.0
  long long ll = __cast(long long, 42);
  printf("%d %g %lld\n", i, d, ll);
}

int main(void) {
  test_box_unbox();
  test_gc_ref_via_anyref();
  test_discriminated_union();
  test_extern_bridge();
  test_numeric();
  return 0;
}
