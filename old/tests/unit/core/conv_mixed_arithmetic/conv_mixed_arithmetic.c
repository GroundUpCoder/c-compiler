// Tests implicit type promotion in binary arithmetic expressions.
// In C, when operands have different types, the "usual arithmetic conversions"
// promote the lower-ranked type to the higher-ranked type.
#include <stdio.h>

int main() {
  // int + double -> double
  int a = 3;
  double b = 1.5;
  double r1 = a + b;
  printf("%.1f\n", r1);  // 4.5

  // int * float -> float
  int c = 4;
  float d = 2.5f;
  float r2 = c * d;
  printf("%.1f\n", (double)r2);  // 10.0

  // int / double -> double
  int e = 7;
  double f = 2.0;
  double r3 = e / f;
  printf("%.1f\n", r3);  // 3.5

  // char + double -> double
  char g = 10;
  double h = 0.5;
  double r4 = g + h;
  printf("%.1f\n", r4);  // 10.5

  // int - float -> float
  int i = 10;
  float j = 3.5f;
  float r5 = i - j;
  printf("%.1f\n", (double)r5);  // 6.5

  // float + double -> double
  float k = 1.5f;
  double l = 2.5;
  double r6 = k + l;
  printf("%.1f\n", r6);  // 4.0

  // Comparison: int < double
  int m = 3;
  double n = 3.5;
  printf("%d\n", m < n);  // 1

  // Comparison: float == float (from int)
  float o = 3.0f;
  int p = 3;
  printf("%d\n", o == (float)p);  // 1

  return 0;
}
