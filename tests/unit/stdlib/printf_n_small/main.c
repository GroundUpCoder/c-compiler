/* Regression: %hhn and %hn must store through the declared width.
 * defaultOnN always did a 4-byte store, zeroing adjacent bytes. */
#include <stdio.h>

int main(void) {
  struct { char a, n, b, c; } s = {11, -1, 22, 33};
  printf("12345%hhn", &s.n);
  printf("\n%d %d %d %d\n", s.a, s.n, s.b, s.c);

  struct { short a, n, b; } t = {1111, -1, 2222};
  printf("abcdefg%hn", &t.n);
  printf("\n%d %d %d\n", t.a, t.n, t.b);

  int full = -1;
  printf("xy%n", &full);
  printf("\n%d\n", full);
  return 0;
}
