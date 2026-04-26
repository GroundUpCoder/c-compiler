#include <stdio.h>

struct Point { int x; int y; };

struct Point make_point(int x, int y) {
  struct Point p;
  p.x = x;
  p.y = y;
  return p;
}

struct Point add_points(struct Point a, struct Point b) {
  struct Point r;
  r.x = a.x + b.x;
  r.y = a.y + b.y;
  return r;
}

void print_point(struct Point p) {
  printf("(%d, %d)\n", p.x, p.y);
}

int main() {
  // Struct return from function
  printf("=== Struct return ===\n");
  struct Point a = make_point(10, 20);
  printf("a.x = %d\n", a.x);
  printf("a.y = %d\n", a.y);

  // Struct pass by value
  printf("=== Pass by value ===\n");
  print_point(a);

  // Pass and return
  printf("=== Pass and return ===\n");
  struct Point b = make_point(30, 40);
  struct Point c = add_points(a, b);
  printf("c.x = %d\n", c.x);
  printf("c.y = %d\n", c.y);

  return 0;
}
