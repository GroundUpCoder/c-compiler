#include <stdio.h>

struct Pair {
  int x;
  int y;
};

struct Node {
  int value;
  struct Node *next;
};

struct Outer {
  int a;
  struct Pair inner;
  int b;
};

void test_both_runtime(int x, int y) {
  struct Pair p = {x, y};
  printf("{%d, %d}\n", p.x, p.y);
}

void test_mixed(int x) {
  struct Pair p = {99, x};
  printf("{%d, %d}\n", p.x, p.y);
}

void test_pointer(void) {
  struct Node b = {20, 0};
  struct Node a = {10, &b};
  printf("%d -> %d\n", a.value, a.next->value);
}

void test_array_runtime(int x, int y) {
  int arr[] = {x, 1, y};
  printf("{%d, %d, %d}\n", arr[0], arr[1], arr[2]);
}

void test_nested_runtime(int x) {
  struct Outer o = {1, {x, 3}, 4};
  printf("{%d, {%d, %d}, %d}\n", o.a, o.inner.x, o.inner.y, o.b);
}

int main(void) {
  test_both_runtime(42, 77);
  test_mixed(42);
  test_pointer();
  test_array_runtime(5, 7);
  test_nested_runtime(88);
  return 0;
}
