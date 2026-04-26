#include <stdio.h>
#include <stdbool.h>

int main() {
  // int -> bool
  bool b1 = 256;
  printf("%d\n", b1);

  bool b2 = 5;
  printf("%d\n", b2);

  bool b3 = 0;
  printf("%d\n", b3);

  bool b4 = -1;
  printf("%d\n", b4);

  // float -> bool
  bool b5 = 0.5f;
  printf("%d\n", b5);

  bool b6 = 0.0f;
  printf("%d\n", b6);

  // double -> bool
  bool b7 = 0.5;
  printf("%d\n", b7);

  bool b8 = 0.0;
  printf("%d\n", b8);

  // long long -> bool
  long long big = 0x100000000LL;
  bool b9 = big;
  printf("%d\n", b9);

  long long zero = 0LL;
  bool b10 = zero;
  printf("%d\n", b10);

  return 0;
}
