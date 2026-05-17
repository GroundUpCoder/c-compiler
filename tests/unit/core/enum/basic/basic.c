// Tests enum declarations and usage.
#include <stdio.h>

enum Color { RED, GREEN, BLUE };
enum Offset { A = 10, B, C, D = 20, E };

int main() {
  enum Color c = RED;
  printf("%d\n", c);      // 0
  printf("%d\n", GREEN);  // 1
  printf("%d\n", BLUE);   // 2

  c = BLUE;
  printf("%d\n", c);  // 2

  // Enum with explicit values
  printf("%d\n", A);   // 10
  printf("%d\n", B);   // 11
  printf("%d\n", C);   // 12
  printf("%d\n", D);   // 20
  printf("%d\n", E);   // 21

  // Enums are integers, can do arithmetic
  printf("%d\n", RED + BLUE);  // 2
  printf("%d\n", A + E);       // 31

  // Enum in switch
  enum Color picked = GREEN;
  switch (picked) {
    case RED:   printf("red\n"); break;
    case GREEN: printf("green\n"); break;
    case BLUE:  printf("blue\n"); break;
  }

  return 0;
}
