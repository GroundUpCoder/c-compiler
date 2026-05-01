// Tests implicit conversions in return statements.
// The return value should be converted to the function's return type.
#include <stdio.h>

// Return double from a float function -> should demote
float return_float_from_double() {
  double d = 3.14;
  return d;
}

// Return float from a double function -> should promote
double return_double_from_float() {
  float f = 2.5f;
  return f;
}

// Return int from a char function -> should truncate
char return_char_from_int() {
  int x = 256 + 65;  // 321, truncated to 'A' (65)
  return x;
}

// Return char from an int function -> should extend
int return_int_from_char() {
  char c = -1;
  return c;  // should be -1 (sign-extended)
}

// Return unsigned char from int function
int return_int_from_uchar() {
  unsigned char uc = 255;
  return uc;  // should be 255 (zero-extended)
}

// Return int from a float function -> should convert
float return_float_from_int() {
  int x = 42;
  return x;
}

int main() {
  printf("%.1f\n", (double)return_float_from_double());  // 3.1 (float precision)
  printf("%.1f\n", return_double_from_float());           // 2.5
  printf("%c\n", return_char_from_int());                  // A
  printf("%d\n", return_int_from_char());                  // -1
  printf("%d\n", return_int_from_uchar());                 // 255
  printf("%.0f\n", (double)return_float_from_int());      // 42
  return 0;
}
