#include <stdio.h>

__struct Animal { int id; };

__struct Dog {
  __extends(__struct Animal);
  int id;       // must repeat parent's fields in order
  int paws;
};

__struct Puppy {
  __extends(__struct Dog);
  int id;
  int paws;
  int cuteness;
};

void describe(__struct Animal *a) {
  printf("animal id=%d\n", a->id);
}

void dog_info(__struct Dog *d) {
  printf("dog id=%d paws=%d\n", d->id, d->paws);
}

int main(void) {
  __struct Dog *d = __new(__struct Dog *, 7, 4);
  printf("d: %d %d\n", d->id, d->paws);    // 7 4

  __struct Puppy *p = __new(__struct Puppy *, 99, 4, 100);
  printf("p: %d %d %d\n", p->id, p->paws, p->cuteness);   // 99 4 100

  // Implicit upcast in function call (Dog → Animal)
  describe(d);                            // animal id=7
  describe(p);                            // animal id=99 (Puppy upcast through chain)

  // Explicit upcast assignment
  __struct Animal *a = d;
  describe(a);                            // animal id=7

  // Implicit upcast Puppy → Dog
  dog_info(p);                            // dog id=99 paws=4

  // ref.test through inheritance chain
  __struct Animal *aref = p;
  printf("aref is Animal: %d\n", __ref_test(__struct Animal *, aref));   // 1
  printf("aref is Dog: %d\n", __ref_test(__struct Dog *, aref));         // 1
  printf("aref is Puppy: %d\n", __ref_test(__struct Puppy *, aref));     // 1

  __struct Animal *aref2 = d;
  printf("aref2 is Puppy: %d\n", __ref_test(__struct Puppy *, aref2));   // 0 (Dog isn't a Puppy)

  // Explicit downcast
  __struct Dog *d2 = __ref_cast(__struct Dog *, aref);
  printf("downcast d2: %d %d\n", d2->id, d2->paws);

  __struct Puppy *p2 = __ref_cast(__struct Puppy *, aref);
  printf("downcast p2: %d %d %d\n", p2->id, p2->paws, p2->cuteness);

  return 0;
}
