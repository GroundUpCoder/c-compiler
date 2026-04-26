// Tests prefix and postfix ++ and -- operators.
#include <stdio.h>

int main() {
  int a = 5;
  printf("%d\n", a++);  // 5, then a=6
  printf("%d\n", a);    // 6
  printf("%d\n", ++a);  // 7
  printf("%d\n", a);    // 7

  printf("%d\n", a--);  // 7, then a=6
  printf("%d\n", a);    // 6
  printf("%d\n", --a);  // 5
  printf("%d\n", a);    // 5

  // Increment on pointers
  int arr[3] = {10, 20, 30};
  int *p = arr;
  printf("%d\n", *p++);  // 10, then p points to arr[1]
  printf("%d\n", *p);    // 20
  printf("%d\n", *++p);  // 30

  // Increment in loop conditions
  int i = 0;
  while (i++ < 3) {}
  printf("%d\n", i);  // 4 (incremented past 3)

  // Prefix in for loop
  int sum = 0;
  for (int j = 0; j < 5; ++j) {
    sum += j;
  }
  printf("%d\n", sum);  // 0+1+2+3+4=10

  return 0;
}
