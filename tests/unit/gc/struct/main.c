#include <stdio.h>

__struct Point { int x; int y; };

__struct Point *make(int a, int b) {
  return __new(__struct Point *, a, b);
}

void test_default(void) {
  printf("=== default ===\n");
  __struct Point *p = __new(__struct Point *);
  printf("%d %d\n", p->x, p->y);   // 0 0
  p->x = 13;
  p->y = 27;
  printf("%d %d\n", p->x, p->y);   // 13 27
}

void test_explicit(void) {
  printf("=== explicit ===\n");
  __struct Point *p = __new(__struct Point *, 3, 7);
  printf("%d %d\n", p->x, p->y);   // 3 7
}

void test_function(void) {
  printf("=== function ===\n");
  __struct Point *p = make(11, 22);
  printf("%d %d\n", p->x, p->y);   // 11 22
}

void test_assign(void) {
  printf("=== assign ===\n");
  __struct Point *a = __new(__struct Point *, 1, 2);
  __struct Point *b = a;           // ref aliasing
  b->x = 99;
  printf("%d %d\n", a->x, a->y);   // 99 2 (same object)
  printf("%d %d\n", b->x, b->y);   // 99 2
}

int main(void) {
  test_default();
  test_explicit();
  test_function();
  test_assign();
  return 0;
}
