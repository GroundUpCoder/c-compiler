#include <stdio.h>

struct Foo {
  int x;
};

void someFunc(struct Foo *f) {
  f->x += 1;
  f->x *= 2;
}

int main() {
  printf("%s\n", "=== Hello from x01.c ===");
  struct Foo f;
  f.x = 123;
  printf("%d\n", f.x);  // 123
  someFunc(&f);
  printf("%s\n", "After someFunc:");
  printf("%d\n", f.x);  // 248

  printf("%s\n", "Address of struct variable:");
  printf("%d\n", &f);
  return 0;
}
