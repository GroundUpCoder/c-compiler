#include <stdio.h>

// Self-referencing struct (linked list)
__struct Node { int v; __struct Node *next; };

// Mutually recursive structs (no forward decl needed — fields look up types
// in tagScope which has the implicit forward decl)
__struct A { int x; __struct B *b; };
__struct B { int y; __struct A *a; };

// Binary tree
__struct Tree { int v; __struct Tree *left; __struct Tree *right; };

__struct Node *cons(int v, __struct Node *tl) {
  __struct Node *n = __new(__struct Node *);
  n->v = v;
  n->next = tl;
  return n;
}

void print_list(__struct Node *head) {
  for (__struct Node *cur = head; cur; cur = cur->next) {
    printf("%d ", cur->v);
  }
  printf("\n");
}

int tree_sum(__struct Tree *t) {
  if (!t) return 0;
  return t->v + tree_sum(t->left) + tree_sum(t->right);
}

void test_linked_list(void) {
  printf("=== linked list ===\n");
  __struct Node *head = 0;
  for (int i = 5; i >= 1; i--) head = cons(i, head);
  print_list(head);
}

void test_mutual(void) {
  printf("=== mutual ===\n");
  __struct A *a = __new(__struct A *);
  __struct B *b = __new(__struct B *);
  a->x = 10; b->y = 20;
  a->b = b; b->a = a;
  printf("%d %d %d %d\n", a->x, a->b->y, b->y, b->a->x);   // 10 20 20 10
}

void test_tree(void) {
  printf("=== tree ===\n");
  __struct Tree *t = __new(__struct Tree *);
  t->v = 1;
  t->left = __new(__struct Tree *);  t->left->v = 2;
  t->right = __new(__struct Tree *); t->right->v = 3;
  t->right->right = __new(__struct Tree *); t->right->right->v = 4;
  printf("sum=%d\n", tree_sum(t));   // 10
}

int main(void) {
  test_linked_list();
  test_mutual();
  test_tree();
  return 0;
}
