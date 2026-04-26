#include <stdio.h>

int main() {
  // Comma expressions in for init and increment
  int a, b;
  for (a = 0, b = 10; a < b; a++, b--) {
    printf("%d:%d ", a, b);
  }
  printf("\n");
  return 0;
}
