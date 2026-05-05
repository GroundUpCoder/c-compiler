#include <stdio.h>

__struct A { int x; };
__struct B { int x; int y; };
__struct C { int x; };  // structurally same as A

int main(void) {
  __struct A *a = __new(__struct A *, 1);
  __struct B *b = __new(__struct B *, 2, 3);

  printf("a is A: %d\n", __ref_test(__struct A *, a));   // 1
  printf("a is B: %d\n", __ref_test(__struct B *, a));   // 0
  printf("b is A: %d\n", __ref_test(__struct A *, b));   // 0
  printf("b is B: %d\n", __ref_test(__struct B *, b));   // 1

  // Structural: A and C have identical shapes → same WASM type
  printf("a is C: %d\n", __ref_test(__struct C *, a));   // 1 (structural dedup)

  // __ref_test asks "is this an instance of T?" — null is not an instance,
  // so chained __ref_test ladders for discriminated unions don't accidentally
  // match every branch when the ref happens to be null.
  __struct A *n;
  printf("null is A: %d\n", __ref_test(__struct A *, n));            // 0

  // __ref_test_null asks the type-lattice question "is x in (ref null T)?",
  // which includes null. Pairs with __ref_cast_null (the non-trapping cast).
  printf("null is A (nullable): %d\n", __ref_test_null(__struct A *, n));   // 1
  printf("a is A (nullable): %d\n", __ref_test_null(__struct A *, a));      // 1

  // Works on arrays
  __array(int) arr = __new(__array(int), 3);
  printf("arr is array(int): %d\n", __ref_test(__array(int), arr));  // 1
  printf("arr is array(double): %d\n", __ref_test(__array(double), arr));  // 0

  return 0;
}
