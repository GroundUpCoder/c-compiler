#include <stdio.h>

int add(int a, int b) {
  return a + b;
}

__export my_add = add;

int main() {
  printf("%d\n", add(3, 4));
  return 0;
}
