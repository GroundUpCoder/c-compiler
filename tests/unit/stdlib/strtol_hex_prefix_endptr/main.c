/* Regression: strtol("0x", NULL, 16) must parse "0" and leave endptr
 * after it — the "0x" prefix is only consumed when a hex digit follows.
 * Also: strtol("0", NULL, 0) left endptr at the start. */
#include <stdio.h>
#include <stdlib.h>

int main(void) {
  char *e;
  const char *s;
  s = "0x";   printf("%ld %d\n", strtol(s, &e, 16), (int)(e - s));
  s = "0xZ";  printf("%ld %d\n", strtol(s, &e, 16), (int)(e - s));
  s = "0x1g"; printf("%ld %d\n", strtol(s, &e, 16), (int)(e - s));
  s = "0x";   printf("%ld %d\n", strtol(s, &e, 0), (int)(e - s));
  s = "0";    printf("%ld %d\n", strtol(s, &e, 0), (int)(e - s));
  s = "0779"; printf("%ld %d\n", strtol(s, &e, 0), (int)(e - s));
  return 0;
}
