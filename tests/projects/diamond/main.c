#include <stdio.h>

int base_value(void);
int mid_value(void);

int main(void) {
  printf("diamond: %d\n", base_value() + mid_value());
  return 0;
}
