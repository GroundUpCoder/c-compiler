// BUG: Local struct/aggregate initialization with runtime (non-constant)
// values silently drops the runtime values (they become zero).
//
// The init list is copied from static data, but initializer expressions
// that can only be evaluated at runtime (local variables, addresses of
// locals) are never patched into the copied data.
//
// Compile-time constants in the same init list ARE stored correctly.

#include <stdio.h>

struct Pair { int a; int b; };

struct Node {
  int val;
  struct Node *next;
};

int main() {
  int x = 10, y = 20;

  // Both fields runtime
  struct Pair p1 = {x, y};
  printf("both_runtime: %d %d\n", p1.a, p1.b);
  // expect: 10 20

  // Mixed: first constant, second runtime
  struct Pair p2 = {99, x};
  printf("mixed: %d %d\n", p2.a, p2.b);
  // expect: 99 10

  // Pointer field with address of local
  int val = 42;
  struct Node n = {1, 0};
  struct Node head = {0, &n};
  printf("head.next->val: %d\n", head.next->val);
  // expect: 1

  // Stack-allocated linked list
  struct Node c = {30, 0};
  struct Node b = {20, &c};
  struct Node a = {10, &b};
  struct Node *p = &a;
  int sum = 0;
  while (p) {
    sum += p->val;
    p = p->next;
  }
  printf("list_sum: %d\n", sum);
  // expect: 60

  return 0;
}
