#include <stdio.h>

struct Point { int x; int y; };

/* ---- member access: s.x++ ---- */
void test_member(void) {
  struct Point p;
  p.x = 10;
  p.y = 20;
  printf("pre-inc member: %d\n", ++p.x);
  printf("post-inc member: %d\n", p.y++);
  printf("after: x=%d y=%d\n", p.x, p.y);
  --p.x;
  p.y--;
  printf("after dec: x=%d y=%d\n", p.x, p.y);
}

/* ---- arrow access: p->x++ ---- */
void test_arrow(void) {
  struct Point pt;
  pt.x = 100;
  pt.y = 200;
  struct Point *p = &pt;
  printf("pre-inc arrow: %d\n", ++p->x);
  printf("post-inc arrow: %d\n", p->y++);
  printf("after: x=%d y=%d\n", pt.x, pt.y);
  --p->x;
  p->y--;
  printf("after dec: x=%d y=%d\n", pt.x, pt.y);
}

/* ---- subscript: arr[i]++ ---- */
void test_subscript(void) {
  int arr[4] = {10, 20, 30, 40};
  printf("pre-inc sub: %d\n", ++arr[0]);
  printf("post-inc sub: %d\n", arr[1]++);
  printf("after: %d %d %d %d\n", arr[0], arr[1], arr[2], arr[3]);
  --arr[2];
  arr[3]--;
  printf("after dec: %d %d %d %d\n", arr[0], arr[1], arr[2], arr[3]);
}

/* ---- dereference: (*p)++ ---- */
void test_deref(void) {
  int x = 50;
  int *p = &x;
  printf("pre-inc deref: %d\n", ++(*p));
  printf("x=%d\n", x);
  printf("post-dec deref: %d\n", (*p)--);
  printf("x=%d\n", x);
}

/* ---- pointer increment via deref ---- */
void test_pointer_deref_inc(void) {
  int arr[3] = {1, 2, 3};
  int *p = arr;
  printf("*p=%d\n", *p);
  p++;
  printf("*p=%d\n", *p);
  ++p;
  printf("*p=%d\n", *p);
}

int main(void) {
  printf("=== member ===\n");
  test_member();
  printf("=== arrow ===\n");
  test_arrow();
  printf("=== subscript ===\n");
  test_subscript();
  printf("=== deref ===\n");
  test_deref();
  printf("=== pointer deref inc ===\n");
  test_pointer_deref_inc();
  return 0;
}
