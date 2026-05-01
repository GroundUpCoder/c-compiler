#include <stdio.h>
#include <iso646.h>

int main(void) {
  int a = 1, b = 0;

  if (a and not b) printf("and/not ok\n");
  if (a or b) printf("or ok\n");
  if (a not_eq b) printf("not_eq ok\n");

  int x = 0xFF;
  printf("compl: %d\n", compl x bitand 0xFF);
  printf("xor: %d\n", x xor 0x0F);
  printf("bitor: %d\n", 0xF0 bitor 0x0F);

  int y = 0;
  y or_eq 3;
  printf("or_eq: %d\n", y);
  y and_eq 2;
  printf("and_eq: %d\n", y);
  y xor_eq 3;
  printf("xor_eq: %d\n", y);

  return 0;
}
