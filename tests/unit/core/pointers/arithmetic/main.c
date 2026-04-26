#include <stdio.h>

struct Foo {
  int x;
};

void someFunc() {
  int x[128];
  printf("%d\n", sizeof(x) / sizeof(x[0]));
  int *start = &x[0];
  int *end = &x[sizeof(x) / sizeof(x[0])];
  printf("%s\n", "START:");
  printf("%d\n", start);
  printf("%s\n", "END:");
  printf("%d\n", end);
}

int main() {
  char buffer[256];
  someFunc();
  return 0;
}
