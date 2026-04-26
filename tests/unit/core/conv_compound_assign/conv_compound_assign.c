// Tests type conversions in compound assignment operators.
// e.g. float += int needs: load float, convert int to float, add, store float.
#include <stdio.h>

int main() {
  // float += int
  float f = 1.5f;
  int x = 2;
  f += x;
  printf("%.1f\n", (double)f);  // 3.5

  // float -= int
  f -= 1;
  printf("%.1f\n", (double)f);  // 2.5

  // float *= int
  f *= 2;
  printf("%.1f\n", (double)f);  // 5.0

  // double += int
  double d = 10.0;
  d += 5;
  printf("%.1f\n", d);  // 15.0

  // int += char (should work since both are i32, but tests the path)
  int i = 100;
  char c = 10;
  i += c;
  printf("%d\n", i);  // 110

  // char += int (result should be truncated to char on store)
  char ch = 100;
  ch += 200;  // 300 truncated to char
  printf("%d\n", ch);  // 44 (300 & 0xFF = 44, but signed: 300-256=44)

  return 0;
}
