#include <stdio.h>

struct BF {
  unsigned int x : 10;
  unsigned int y : 10;
  unsigned int z : 10;
};

/* Pass struct with bit-fields by value to a function */
void print_bf(struct BF b) {
  printf("x=%u y=%u z=%u\n", b.x, b.y, b.z);
}

/* Modify bit-field through pointer parameter */
void set_x(struct BF *b, unsigned int val) {
  b->x = val;
}

int main() {
  /* Struct copy preserves bit-fields */
  struct BF a;
  unsigned int *ar = (unsigned int *)&a;
  *ar = 0;
  a.x = 100;
  a.y = 200;
  a.z = 300;
  struct BF b = a;
  printf("copy: ");
  print_bf(b);

  /* Modify original doesn't affect copy */
  a.x = 999;
  printf("orig_x=%u copy_x=%u\n", a.x, b.x);

  /* Assignment between structs */
  struct BF d;
  unsigned int *dr = (unsigned int *)&d;
  *dr = 0;
  d = b;
  printf("assigned: ");
  print_bf(d);

  /* Pointer parameter modification */
  set_x(&d, 42);
  printf("after_set_x: ");
  print_bf(d);

  /* Array of structs with bit-fields, passed by value via subscript */
  struct BF arr[3];
  unsigned int *arrr = (unsigned int *)arr;
  int i;
  for (i = 0; i < 3; i++) arrr[i] = 0;
  arr[0].x = 1;   arr[0].y = 2;   arr[0].z = 3;
  arr[1].x = 10;  arr[1].y = 20;  arr[1].z = 30;
  arr[2].x = 100; arr[2].y = 200; arr[2].z = 300;
  for (i = 0; i < 3; i++) {
    printf("arr[%d]: ", i);
    print_bf(arr[i]);
  }

  /* Nested struct containing bit-fields */
  struct Outer {
    int id;
    struct BF inner;
    int tail;
  };
  struct Outer o;
  o.id = 42;
  unsigned int *oi = (unsigned int *)&o.inner;
  *oi = 0;
  o.inner.x = 7;
  o.inner.y = 8;
  o.inner.z = 9;
  o.tail = 99;
  printf("outer: id=%d tail=%d\n", o.id, o.tail);
  printf("inner: ");
  print_bf(o.inner);

  return 0;
}
