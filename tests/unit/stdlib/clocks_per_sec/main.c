/* POSIX/XSI requires CLOCKS_PER_SEC == 1000000. */
#include <stdio.h>
#include <time.h>

int main(void) {
  printf("%ld\n", (long)CLOCKS_PER_SEC);
  clock_t a = clock();
  volatile long x = 0;
  for (long i = 0; i < 2000000; i++) x += i;
  clock_t b = clock();
  printf("%d\n", b >= a);
  return 0;
}
