// Tests implicit conversions in assignments (not just initialization).
// The RHS should be converted to the LHS type.
#include <stdio.h>

int main() {
  // double -> float assignment
  float f;
  double d = 1.5;
  f = d;
  printf("%.1f\n", (double)f);  // 1.5

  // float -> double assignment
  double d2;
  float f2 = 2.5f;
  d2 = f2;
  printf("%.1f\n", d2);  // 2.5

  // int -> char assignment (truncation)
  char c;
  int big = 256 + 66;
  c = big;
  printf("%c\n", c);  // B (66)

  // char -> int assignment (sign extension)
  int i;
  char neg = -5;
  i = neg;
  printf("%d\n", i);  // -5

  // int -> float assignment
  float f3;
  int val = 100;
  f3 = val;
  printf("%.0f\n", (double)f3);  // 100

  // double -> int assignment (truncation)
  int trunc;
  double pi = 3.14;
  trunc = (int)pi;
  printf("%d\n", trunc);  // 3

  // Compound assignment with different types: float += int
  float f4 = 1.5f;
  int inc = 2;
  f4 = f4 + (float)inc;  // explicit for now
  printf("%.1f\n", (double)f4);  // 3.5

  return 0;
}
