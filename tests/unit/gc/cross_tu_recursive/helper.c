__struct Node { int v; __struct Node *next; };

__struct Node *make_list(int n) {
  __struct Node *head = 0;
  for (int i = n; i >= 1; i--) {
    __struct Node *nn = __new(__struct Node *);
    nn->v = i;
    nn->next = head;
    head = nn;
  }
  return head;
}

int list_sum(__struct Node *head) {
  int s = 0;
  for (__struct Node *cur = head; cur; cur = cur->next) s += cur->v;
  return s;
}

__struct A { int x; __struct B *b; };
__struct B { int y; __struct A *a; };

int ab_get_y(__struct A *a) { return a->b->y; }
