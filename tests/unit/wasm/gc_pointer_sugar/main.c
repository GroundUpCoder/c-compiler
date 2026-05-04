#include <stdio.h>

// Recursive type written with C-pointer-style syntax — IDE-friendly form.
__struct Node { int v; __struct Node *next; };

// Inheritance + pointer-form
__struct Animal { int id; };
__struct Dog {
  __extends(__struct Animal);
  int id;
  int paws;
};

__struct Node *cons(int v, __struct Node *tl) {
  auto n = __new(__struct Node);
  n->v = v;
  n->next = tl;
  return n;
}

void print_list(__struct Node *head) {
  for (__struct Node *p = head; p; p = p->next) {
    printf("%d ", p->v);
  }
  printf("\n");
}

void describe(__struct Animal *a) {
  printf("animal id=%d\n", a->id);
}

int main(void) {
  // Build list using pointer-form
  __struct Node *head = 0;
  for (int i = 5; i >= 1; i--) head = cons(i, head);
  print_list(head);

  // Bare and pointer-form are interchangeable (same WASM type)
  __struct Node h_bare = head;
  __struct Node *h_ptr = h_bare;
  printf("bare.v=%d ptr->v=%d\n", h_bare.v, h_ptr->v);

  // -> on GC struct works (== . sugar)
  printf("head->next->v=%d\n", head->next->v);

  // null with pointer-form
  __struct Node *empty = 0;
  printf("empty null: %d\n", empty == 0);
  if (!empty) printf("(via !)\n");

  // Multi-level collapses (no real use, but doesn't break)
  __struct Node **wat = head;
  printf("wat->v=%d\n", wat->v);

  // GC array with pointer-form
  __array(int) *arr = __new_array(int, 100, 200, 300);
  printf("len=%d arr[2]=%d\n", __array_len(arr), arr[2]);

  // Inheritance: pass child via pointer-form to parent-pointer param
  __struct Dog *d = __new(__struct Dog, 7, 4);
  describe(d);

  // -> through inheritance chain
  printf("d->id=%d d->paws=%d\n", d->id, d->paws);

  return 0;
}
