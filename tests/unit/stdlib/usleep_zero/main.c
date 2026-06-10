/* usleep(0) must not clamp to a millisecond sleep. */
#include <stdio.h>
#include <unistd.h>
#include <time.h>

int main(void) {
  struct timespec a, b;
  clock_gettime(CLOCK_MONOTONIC, &a);
  int r = 0;
  for (int i = 0; i < 20; i++) r |= usleep(0);
  clock_gettime(CLOCK_MONOTONIC, &b);
  long ms = (b.tv_sec - a.tv_sec) * 1000 + (b.tv_nsec - a.tv_nsec) / 1000000;
  printf("%d %d\n", r, ms < 100);
  return 0;
}
