#include <stdio.h>

// Self-recursive type shared across two TUs. Tarjan + minimal rec groups
// puts this in its own singleton rec group; WASM canonicalizes the rec
// groups by structure so both TUs' Node refer to the same canonical type.
__struct Node { int v; __struct Node *next; };

extern __struct Node *make_list(int n);
extern int list_sum(__struct Node *head);

// Mutually recursive types — same SCC across TUs.
__struct A { int x; __struct B *b; };
__struct B { int y; __struct A *a; };

extern int ab_get_y(__struct A *a);

int main(void) {
  __struct Node *l = make_list(5);
  printf("sum: %d\n", list_sum(l));   // 1+2+3+4+5 = 15

  __struct A *a = __new(__struct A *);
  __struct B *b = __new(__struct B *);
  a->x = 10; b->y = 99; a->b = b; b->a = a;
  printf("y: %d\n", ab_get_y(a));     // 99

  return 0;
}
