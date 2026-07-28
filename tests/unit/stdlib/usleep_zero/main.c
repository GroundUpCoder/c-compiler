/* usleep(0) is a valid request that must succeed: returns 0, errno untouched.
 *
 * This test used to also assert `elapsed_ms < 100` over 20 calls, meaning to
 * catch "usleep(0) clamped to a 1 ms sleep". It could not: a real 1 ms clamp
 * over 20 calls is 20 ms, which sails under 100 (demonstrated in todos/0361 —
 * injecting that exact clamp into host.js left this test GREEN). What the
 * budget did do is go red under lane contention, where the suite runs ~2x
 * slower — a statement about the machine, not about usleep.
 *
 * The clamp is a property of the HOST's sleep primitive, not of compiled C, so
 * it is now asserted where it is observable with no clock at all:
 * tests/host/test_sleep_clamp.js records the millisecond value handed to
 * setTimeout (JSPI flavor) / Atomics.wait (block-FS flavor). What is left here
 * is the part C can see, and it is deterministic. */
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
