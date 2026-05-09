// Static functions referenced ONLY through a global function-pointer
// table must survive tree-shake. Their addresses are taken in a static
// const initializer; nothing else mentions them by name.

#include <stdio.h>

static int op_add(int a, int b) { return a + b; }
static int op_sub(int a, int b) { return a - b; }
static int op_mul(int a, int b) { return a * b; }

typedef int (*binop)(int, int);
static const binop ops[] = { op_add, op_sub, op_mul };

int main(void) {
  printf("%d\n", ops[0](7, 3));  // 10
  printf("%d\n", ops[1](7, 3));  // 4
  printf("%d\n", ops[2](7, 3));  // 21
  return 0;
}
