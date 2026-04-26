#include <stdio.h>

struct Inner {
  int a;
  int b;
};

struct Outer {
  int x;
  struct Inner inner;
  int y;
};

struct WithArray {
  int x;
  int arr[3];
  int y;
};

struct SimpleArr {
  int arr[3];
};

int main() {
  // Struct in struct
  printf("=== Struct in struct ===\n");
  struct Outer o;
  o.x = 1;
  o.inner.a = 2;
  o.inner.b = 3;
  o.y = 4;
  printf("o.x = %d (expect 1)\n", o.x);
  printf("o.inner.a = %d (expect 2)\n", o.inner.a);
  printf("o.inner.b = %d (expect 3)\n", o.inner.b);
  printf("o.y = %d (expect 4)\n", o.y);

  // Array in struct (simple)
  printf("=== Array in struct (simple) ===\n");
  struct SimpleArr sa;
  sa.arr[0] = 42;
  printf("sa.arr[0] = %d\n", sa.arr[0]);

  // Array in struct (full)
  printf("=== Array in struct (full) ===\n");
  struct WithArray s;
  s.x = 10;
  s.arr[0] = 100;
  s.arr[1] = 200;
  s.arr[2] = 300;
  s.y = 20;
  printf("s.x = %d (expect 10)\n", s.x);
  printf("s.arr[0] = %d (expect 100)\n", s.arr[0]);
  printf("s.arr[1] = %d (expect 200)\n", s.arr[1]);
  printf("s.arr[2] = %d (expect 300)\n", s.arr[2]);
  printf("s.y = %d (expect 20)\n", s.y);

  return 0;
}
