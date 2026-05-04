#include <stdio.h>

__struct Animal { int id; };
__struct Dog {
  __extends(__struct Animal);
  int id;
  int paws;
};

void describe(__struct Animal a) {
  printf("animal id=%d\n", a.id);
}

__struct Dog make_dog(int id, int paws) {
  return __new(__struct Dog, id, paws);
}
