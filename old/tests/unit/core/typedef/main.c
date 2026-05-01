#include <stdio.h>

typedef int MyInt;
typedef int *IntPtr;
typedef struct { int x; int y; } Point;
typedef int Arr5[5];

MyInt add(MyInt a, MyInt b) { return a + b; }

int main() {
  MyInt x = 10;
  IntPtr p = &x;
  Point pt;
  pt.x = 3;
  pt.y = 4;
  Arr5 arr;
  arr[0] = 100;

  printf("%d\n", add(x, 20));
  printf("%d\n", *p);
  printf("%d %d\n", pt.x, pt.y);
  printf("%d\n", arr[0]);

  // Typedef of typedef
  typedef MyInt MyInt2;
  MyInt2 z = 42;
  printf("%d\n", z);

  // Typedef of function pointer
  typedef int (*BinOp)(int, int);
  BinOp op = add;
  printf("%d\n", op(5, 6));

  return 0;
}
