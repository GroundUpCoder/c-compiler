// Tests type casts and implicit conversions.
#include <stdio.h>

int main() {
  // int <-> char
  int x = 'A';
  printf("%d\n", x);  // 65
  char c = 66;
  printf("%c\n", c);  // B

  // Signed/unsigned truncation
  int big = 256 + 42;
  char trunc = (char)big;
  printf("%d\n", trunc);  // 42 (truncated to low byte)

  // Negative char to int (sign extension)
  char neg = -1;
  int extended = neg;
  printf("%d\n", extended);  // -1

  // unsigned char to int (zero extension)
  unsigned char uc = 255;
  int from_uc = uc;
  printf("%d\n", from_uc);  // 255

  // int <-> float
  int i = 7;
  float f = (float)i;
  printf("%d\n", (int)f);  // 7

  float f2 = 3.7;
  int truncated = (int)f2;
  printf("%d\n", truncated);  // 3

  // pointer <-> int round-trip
  int val = 42;
  int *p = &val;
  long addr = (long)p;
  int *p2 = (int *)addr;
  printf("%d\n", *p2);  // 42

  // Implicit conversion in arithmetic: char + int = int
  char a = 10;
  int b = 20;
  printf("%d\n", a + b);  // 30

  return 0;
}
