// Tests float <-> int conversions in various contexts.
#include <stdio.h>

int main() {
  // double -> int (explicit cast, truncation toward zero)
  printf("%d\n", (int)3.9);    // 3
  printf("%d\n", (int)-3.9);   // -3
  printf("%d\n", (int)0.5);    // 0

  // int -> double
  int x = -42;
  double d = x;
  printf("%.1f\n", d);         // -42.0

  // float -> int
  float f = -7.8f;
  int i = (int)f;
  printf("%d\n", i);           // -7

  // int -> float
  int big = 1000000;
  float f2 = (float)big;
  printf("%.0f\n", (double)f2);  // 1000000

  // float <-> double
  float f3 = 1.5f;
  double d2 = f3;              // promote
  printf("%.1f\n", d2);        // 1.5
  double d3 = 2.5;
  float f4 = (float)d3;       // demote
  printf("%.1f\n", (double)f4); // 2.5

  // Arithmetic mixing int and float (requires conversion)
  int a = 3;
  float b = 1.5f;
  float c = (float)a + b;
  printf("%.1f\n", (double)c); // 4.5

  return 0;
}
