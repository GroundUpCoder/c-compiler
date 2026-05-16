// Regression: an `enum X` tag definition must work even when `X` has
// already been used as a typedef name. Tag and typedef namespaces are
// distinct (C99 6.2.3). QuickJS's quickjs.c does this:
//
//   typedef enum OPCodeEnum OPCodeEnum;   // forward
//   ...
//   enum OPCodeEnum { OP_A, OP_B };       // definition
//
#include <stdio.h>

typedef enum Op Op;
typedef enum Color Color;

enum Op  { OP_ADD, OP_SUB, OP_MUL };
enum Color { RED = 10, GREEN, BLUE };

int main(void) {
  Op   op = OP_SUB;
  Color c = BLUE;
  printf("%d %d %d\n", op, c, OP_MUL + RED);
  return 0;
}
