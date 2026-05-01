#include <stdio.h>

struct Point { int x; int y; };

struct Big { int a; int b; int c; int d; };

struct Nested {
  struct Point p;
  int z;
};

int main() {
  // Basic struct assignment
  printf("=== Basic assign ===\n");
  struct Point a;
  a.x = 10;
  a.y = 20;
  struct Point b;
  b = a;
  printf("b.x = %d\n", b.x);
  printf("b.y = %d\n", b.y);

  // Modify original, copy should be independent
  a.x = 99;
  printf("b.x = %d\n", b.x);

  // Copy initialization
  printf("=== Copy init ===\n");
  struct Point c;
  c.x = 3;
  c.y = 4;
  struct Point d = c;
  printf("d.x = %d\n", d.x);
  printf("d.y = %d\n", d.y);

  // Bigger struct
  printf("=== Big struct ===\n");
  struct Big bg1;
  bg1.a = 1; bg1.b = 2; bg1.c = 3; bg1.d = 4;
  struct Big bg2 = bg1;
  printf("%d %d %d %d\n", bg2.a, bg2.b, bg2.c, bg2.d);

  // Nested struct assignment
  printf("=== Nested assign ===\n");
  struct Nested n1;
  n1.p.x = 5;
  n1.p.y = 6;
  n1.z = 7;
  struct Nested n2 = n1;
  printf("n2.p.x = %d\n", n2.p.x);
  printf("n2.p.y = %d\n", n2.p.y);
  printf("n2.z = %d\n", n2.z);

  return 0;
}
