/* Regression: a function declarator returning a function pointer
 * — int (*pick(int))(int) — was misparsed as returning int*. */
#include <stdio.h>

int inc(int x) { return x + 1; }
int dec(int x) { return x - 1; }

int (*pick(int which))(int) { return which ? inc : dec; }

/* signal()-style declaration */
void (*getsig(int sig, void (*fn)(int)))(int);

/* and with a pointer return inside */
int *(*pickp(void))(int);

int main(void) {
  printf("%d %d\n", pick(1)(5), pick(0)(5));
  int (*fp)(int) = pick(1);
  printf("%d\n", fp(41));
  return 0;
}
