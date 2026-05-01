#include <stdio.h>

int *get_counter(void) {
  static int count = 0;
  count = count + 1;
  return &count;
}

int main(void) {
  int *p1 = get_counter();
  int *p2 = get_counter();
  printf("same addr: %d\n", p1 == p2);
  printf("val: %d\n", *p2);
  return 0;
}
