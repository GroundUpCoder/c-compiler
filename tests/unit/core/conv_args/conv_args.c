// Tests implicit conversions when passing arguments to functions.
// Arguments should be converted to parameter types.
#include <stdio.h>

float add_floats(float a, float b) {
  return a + b;
}

double add_doubles(double a, double b) {
  return a + b;
}

int add_ints(int a, int b) {
  return a + b;
}

char first_char(char a, char b) {
  return a;
}

int takes_int(int x) {
  return x;
}

int main() {
  // Pass double to float parameter -> should demote
  double d = 1.5;
  float result = add_floats(d, d);
  printf("%.1f\n", (double)result);  // 3.0

  // Pass float to double parameter -> should promote
  float f = 2.5f;
  double result2 = add_doubles(f, f);
  printf("%.1f\n", result2);  // 5.0

  // Pass int to char parameter -> should truncate
  int big = 256 + 65;  // 321
  char ch = first_char(big, 0);
  printf("%c\n", ch);  // A (65)

  // Pass char to int parameter -> should extend
  char c = -3;
  int r = takes_int(c);
  printf("%d\n", r);  // -3

  // Pass int to float parameter -> should convert
  int x = 10;
  float r2 = add_floats(x, x);
  printf("%.0f\n", (double)r2);  // 20

  return 0;
}
