// BUG: goto into a nested compound statement corrupts the stack slot of a variable declared in an intermediate scope (the label-hoisting rewrite loses the slot)
// C11: 6.2.4p6 (jumping into a block leaves the object with indeterminate value, but a store before any read makes it well-defined); 6.8.6.1 (goto to any label in the function)
// EXPECT: x is assigned 42 before being read, so the program prints x=42; matches native clang
#include <stdio.h>
int main(void) {
  int cond = 1;
  if (cond) goto L;
  {
    int x;
    {
L:
      x = 42;
      printf("x=%d\n", x);
      return 0;
    }
  }
}
