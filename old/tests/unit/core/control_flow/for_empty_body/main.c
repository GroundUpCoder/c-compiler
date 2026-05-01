#include <stdio.h>

int main() {
  // Empty for body (semicolon)
  int sum = 0;
  int i;
  for (i = 1; i <= 10; sum += i, i++);
  printf("sum=%d\n", sum);
  return 0;
}
