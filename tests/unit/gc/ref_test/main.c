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

  // Null is in (ref null T) for any T
  __struct A *n;
  printf("null is A: %d\n", __ref_test(__struct A *, n));  // 1

  // Works on arrays
  __array(int) arr = __new(__array(int), 3);
  printf("arr is array(int): %d\n", __ref_test(__array(int), arr));  // 1
  printf("arr is array(double): %d\n", __ref_test(__array(double), arr));  // 0

  return 0;
}
