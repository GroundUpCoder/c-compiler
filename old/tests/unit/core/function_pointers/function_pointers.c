// Tests function pointers: declaration, assignment, calling.
#include <stdio.h>

int add(int a, int b) { return a + b; }
int mul(int a, int b) { return a * b; }

int apply(int (*fn)(int, int), int x, int y) {
  return fn(x, y);
}

int main() {
  int (*op)(int, int);

  op = add;
  printf("%d\n", op(3, 4));  // 7

  op = mul;
  printf("%d\n", op(3, 4));  // 12

  // Passing function pointer as argument
  printf("%d\n", apply(add, 10, 20));  // 30
  printf("%d\n", apply(mul, 10, 20));  // 200

  // Array of function pointers
  int (*ops[2])(int, int) = {add, mul};
  printf("%d\n", ops[0](5, 6));  // 11
  printf("%d\n", ops[1](5, 6));  // 30

  return 0;
}
