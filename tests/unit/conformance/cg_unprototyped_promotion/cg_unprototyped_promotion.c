// BUG: calling a function declared without a prototype crashes the compiler (internal compiler error) when arguments need default promotions
// C11: 6.5.2.2p6 (call through a declaration with no prototype: integer promotions + float->double on each argument; defined behavior when the promoted types match the definition's parameter types)
// EXPECT: float 1.5f promotes to double 1.5, f computes (int)(1.5*2) == 3; matches native clang
#include <stdio.h>
int f();
int main(void) {
  float x = 1.5f;
  printf("%d\n", f(x));
  return 0;
}
int f(double b) { return (int)(b * 2); }
