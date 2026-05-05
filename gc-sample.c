// Sample C program exercising the WASM GC features:
//   - __struct with single inheritance (__extends)
//   - __array(T) heap arrays
//   - __eqref discriminated union with __ref_test
//   - Linked list built from GC structs
#include <stdio.h>

__struct Shape {
  int kind;
};

__struct Circle {
  __extends(__struct Shape);
  int kind;
  int radius;
};

__struct Square {
  __extends(__struct Shape);
  int kind;
  double side;   // double (not int) so this struct is structurally distinct from Circle
};

__struct Node {
  int value;
  __struct Node *next;
};

static double area(__struct Shape *s) {
  if (__ref_test(__struct Circle *, s)) {
    __struct Circle *c = __ref_cast(__struct Circle *, s);
    return 3.14159265 * c->radius * c->radius;
  }
  if (__ref_test(__struct Square *, s)) {
    __struct Square *q = __ref_cast(__struct Square *, s);
    return q->side * q->side;
  }
  return 0.0;
}

static __struct Node *prepend(__struct Node *head, int v) {
  __struct Node *n = __new(__struct Node *, v, head);
  return n;
}

static int sum_list(__struct Node *head) {
  int total = 0;
  for (auto cur = head; cur; cur = cur->next) total += cur->value;
  return total;
}

static void describe(__eqref x) {
  if (__ref_test(__struct Circle *, x)) {
    __struct Circle *c = __ref_cast(__struct Circle *, x);
    printf("circle r=%d\n", c->radius);
  } else if (__ref_test(__struct Square *, x)) {
    __struct Square *q = __ref_cast(__struct Square *, x);
    printf("square s=%g\n", q->side);
  } else {
    int n = __cast(int, x);
    printf("boxed int %d\n", n);
  }
}

int main(void) {
  // Heap-allocated array of ints, GC-managed
  __array(int) nums = __new_array(int, 10, 20, 30, 40, 50);
  int n = __array_len(nums);
  int total = 0;
  for (int i = 0; i < n; i++) total += nums[i];
  printf("array len=%d sum=%d\n", n, total);

  // Array of GC struct refs (note: element type uses '*')
  __array(__struct Shape *) shapes = __new_array(__struct Shape *,
      __new(__struct Circle *, 0, 5),
      __new(__struct Square *, 1, 4.0),
      __new(__struct Circle *, 0, 3));

  for (int i = 0; i < __array_len(shapes); i++) {
    printf("shape[%d] area=%.4f\n", i, area(shapes[i]));
  }

  // Linked list of GC nodes
  __struct Node *head = NULL;
  for (int i = 1; i <= 5; i++) head = prepend(head, i);
  printf("list sum=%d\n", sum_list(head));

  // __eqref-as-discriminated-union: struct refs and boxed primitives
  __array(__eqref) anys = __new_array(__eqref,
      __new(__struct Circle *, 0, 7),
      42,
      __new(__struct Square *, 1, 9.0));
  for (int i = 0; i < __array_len(anys); i++) describe(anys[i]);

  return 0;
}
