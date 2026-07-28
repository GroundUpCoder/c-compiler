/* usleep(0) is a valid request that must succeed under the block-FS backend:
 * returns 0, errno untouched.
 *
 * The wall-clock half of this test (`elapsed_ms < 100` over 20 calls) is gone —
 * see tests/unit/stdlib/usleep_zero/main.c for the full reasoning (todos/0361).
 * Short version: the budget never caught the clamp it was written for (20 x 1 ms
 * = 20 ms, under 100), but it did go red under lane contention. The clamp is now
 * asserted directly, with no clock, in tests/host/test_sleep_clamp.js — which
 * covers THIS backend's primitive too (Atomics.wait's timeout argument). */
#include <stdio.h>
#include <errno.h>
#include <unistd.h>

int main(void) {
  errno = 0;
  int r = 0;
  for (int i = 0; i < 20; i++) r |= usleep(0);
  printf("%d %d\n", r, errno);
  return 0;
}
