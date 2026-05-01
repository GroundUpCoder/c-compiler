// Tests narrowing conversions and edge cases for char/short types.
#include <stdio.h>

int main() {
  // Signed char boundaries
  char c1 = 127;
  printf("%d\n", c1);   // 127
  char c2 = 128;        // wraps to -128
  printf("%d\n", c2);   // -128
  char c3 = -128;
  printf("%d\n", c3);   // -128
  char c4 = 255;        // wraps to -1
  printf("%d\n", c4);   // -1

  // Unsigned char boundaries
  unsigned char uc1 = 255;
  printf("%d\n", uc1);  // 255
  unsigned char uc2 = 256;  // wraps to 0
  printf("%d\n", uc2);  // 0
  unsigned char uc3 = -1;   // wraps to 255
  printf("%d\n", uc3);  // 255

  // Short boundaries
  short s1 = 32767;
  printf("%d\n", s1);   // 32767
  short s2 = 32768;     // wraps to -32768
  printf("%d\n", s2);   // -32768

  // Cast chains: int -> char -> int (should lose high bits)
  int x = 0x1234;
  char c = (char)x;
  int y = c;
  printf("%d\n", y);    // 52 (0x34)

  // Negative cast chain: int -> char -> int (should sign-extend)
  int x2 = 0xFF80;      // low byte is 0x80 = -128 as signed char
  char c5 = (char)x2;
  int y2 = c5;
  printf("%d\n", y2);   // -128

  return 0;
}
