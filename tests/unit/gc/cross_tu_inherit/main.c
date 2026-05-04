#include <stdio.h>

// Both TUs declare the parent and (this TU's) subclass identically.
// Cross-TU function calls pass child refs into a parent-typed parameter.
__struct Animal { int id; };
__struct Dog {
  __extends(__struct Animal);
  int id;
  int paws;
};

extern void describe(__struct Animal *a);
extern __struct Dog *make_dog(int id, int paws);

int main(void) {
  __struct Dog *d = make_dog(42, 4);
  printf("d: %d %d\n", d->id, d->paws);

  // Implicit upcast: pass Dog where Animal expected, across TU
  describe(d);

  // Downcast a Dog returned from helper TU
  __struct Animal *a = d;
  __struct Dog *d2 = __ref_cast(__struct Dog *, a);
  printf("d2: %d %d\n", d2->id, d2->paws);

  // ref.test through inheritance
  printf("d is Animal: %d\n", __ref_test(__struct Animal *, d));
  printf("d is Dog: %d\n", __ref_test(__struct Dog *, d));

  return 0;
}
