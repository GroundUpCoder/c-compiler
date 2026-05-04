#include <stdio.h>

__struct Foo { int x; };

int main(void) {
  // Auto-null init: any GC ref local starts as null without explicit init
  __struct Foo *a;
  __array(int) ar;
  printf("a auto: %d\n", a == 0);     // 1
  printf("ar auto: %d\n", ar == 0);   // 1

  // __ref_null can re-null an allocated ref
  __struct Foo *b = __new(__struct Foo *, 7);
  printf("b before: %d\n", b == 0);   // 0
  b = __ref_null(__struct Foo *);
  printf("b after: %d\n", b == 0);    // 1

  // __ref_null on __array
  __array(int) arr = __new(__array(int), 4);
  arr = __ref_null(__array(int));
  printf("arr: %d\n", arr == 0);      // 1

  // __ref_null on __externref
  __externref er = __ref_null(__externref);
  printf("er: %d\n", er == 0);        // 1

  // __ref_eq via == on two refs
  __struct Foo *c = __new(__struct Foo *, 1);
  printf("c eq null: %d\n", c == __ref_null(__struct Foo *));  // 0
  c = __ref_null(__struct Foo *);
  printf("c eq null: %d\n", c == __ref_null(__struct Foo *));  // 1

  return 0;
}
