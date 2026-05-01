#include <stdio.h>
#include "inline.h"

int get_a(void);
int get_b(void);

int main(void) {
  printf("%d\n", inline_add(1, 2));
  printf("%d\n", get_a());
  printf("%d\n", get_b());
  return 0;
}
