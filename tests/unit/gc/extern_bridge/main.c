#include <stdio.h>

__struct Foo { int x; int y; };
__struct Bar { int v; };

int main(void) {
  __struct Foo *f = __new(__struct Foo *, 7, 42);

  // Round-trip through externref preserves identity
  __externref ext = __ref_as_extern(f);
  printf("ext null: %d\n", ext == 0);
  __eqref any = __ref_as_eq(ext);
  __struct Foo *f2 = __ref_cast(__struct Foo *, any);
  printf("recovered: %d %d\n", f2->x, f2->y);
  printf("same ref: %d\n", f == f2);

  // anyref can hold any GC type — discriminate via __ref_test
  __struct Bar *b = __new(__struct Bar *, 99);
  __eqref any_f = __ref_as_eq(__ref_as_extern(f));
  __eqref any_b = __ref_as_eq(__ref_as_extern(b));
  printf("any_f is Foo: %d\n", __ref_test(__struct Foo *, any_f));   // 1
  printf("any_f is Bar: %d\n", __ref_test(__struct Bar *, any_f));   // 0
  printf("any_b is Bar: %d\n", __ref_test(__struct Bar *, any_b));   // 1

  // anyref + array
  __array(int) arr = __new_array(int, 1, 2, 3);
  __eqref any_a = __ref_as_eq(__ref_as_extern(arr));
  printf("any_a is array(int): %d\n", __ref_test(__array(int), any_a));   // 1
  __array(int) arr2 = __ref_cast(__array(int), any_a);
  printf("arr2 len: %d\n", __array_len(arr2));

  // Auto-null for anyref
  __eqref nul;
  printf("nul null: %d\n", nul == 0);

  return 0;
}
