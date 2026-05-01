// Test global function pointer: initialization, calling, reassignment.
#include <stdio.h>

int add(int a, int b) { return a + b; }
int mul(int a, int b) { return a * b; }

int (*gop)(int, int) = add;

int main() {
  printf("%d\n", gop(3, 4));   // 7
  gop = mul;
  printf("%d\n", gop(3, 4));   // 12
  gop = add;
  printf("%d\n", gop(10, 5));  // 15
  return 0;
}
