/* Regression: sleep() was a silent no-op (returned immediately);
 * usleep/nanosleep suspended correctly. */
#include <stdio.h>
#include <unistd.h>
#include <time.h>

int main(void) {
  struct timespec a, b;
  clock_gettime(CLOCK_MONOTONIC, &a);
  unsigned r = sleep(1);
  clock_gettime(CLOCK_MONOTONIC, &b);
  long ms = (b.tv_sec - a.tv_sec) * 1000 + (b.tv_nsec - a.tv_nsec) / 1000000;
  printf("%u %d\n", r, ms >= 900 ? 1 : 0);
  return 0;
}
