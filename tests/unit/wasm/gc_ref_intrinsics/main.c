#include <stdio.h>

__struct Point { int x; int y; };

int main(void) {
  // __ref_is_null on default-initialized GC ref (uninitialized = null)
  __struct Point a;
  printf("a null: %d\n", __ref_is_null(a));     // 1

  // After __new, no longer null
  __struct Point b = __new(__struct Point, 1, 2);
  printf("b null: %d\n", __ref_is_null(b));     // 0

  // __ref_eq: aliasing
  __struct Point c = b;
  printf("b eq c: %d\n", __ref_eq(b, c));       // 1
  printf("b eq a: %d\n", __ref_eq(b, a));       // 0

  // Two distinct allocations are not equal even if fields are equal
  __struct Point d = __new(__struct Point, 1, 2);
  printf("b eq d: %d\n", __ref_eq(b, d));       // 0

  // Works on __array too
  __array(int) arr = __new(__array(int), 3);
  __array(int) arr2 = arr;
  __array(int) arr3 = __new(__array(int), 3);
  printf("arr null: %d\n", __ref_is_null(arr)); // 0
  printf("arr eq arr2: %d\n", __ref_eq(arr, arr2)); // 1
  printf("arr eq arr3: %d\n", __ref_eq(arr, arr3)); // 0

  // Re-null an existing ref
  b = a;
  printf("b null after reassign: %d\n", __ref_is_null(b)); // 1

  return 0;
}
