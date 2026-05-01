// Tests type conversions in global variable initialization.
#include <stdio.h>

// double literal -> float global
float gf = 3.7;

// int literal -> float global
float gf2 = 42;

// float literal -> double global
double gd = 2.5f;

// Large int -> char global (truncation)
char gc = 256 + 65;  // should be 'A' (65)

int main() {
  printf("%.1f\n", (double)gf);   // 3.7
  printf("%.0f\n", (double)gf2);  // 42
  printf("%.1f\n", gd);           // 2.5
  printf("%c\n", gc);             // A
  return 0;
}
