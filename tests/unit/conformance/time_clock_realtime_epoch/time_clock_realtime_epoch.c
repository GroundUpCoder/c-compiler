// BUG: clock_gettime(CLOCK_REALTIME) returns time since process start (tv_sec near 0) instead of seconds since the Epoch, so it disagrees with time().
// C11: 7.27.2.4 time() returns the current calendar time; POSIX clock_gettime(CLOCK_REALTIME) is defined as "seconds since the Epoch" — the two must agree to within moments.
// EXPECT: "1\n" — |time(0) - CLOCK_REALTIME.tv_sec| < 60 (verified against native clang).
#include <stdio.h>
#include <time.h>

int main(void) {
  time_t t = time(0);
  struct timespec ts;
  clock_gettime(CLOCK_REALTIME, &ts);
  long long d = (long long)t - (long long)ts.tv_sec;
  printf("%d\n", d > -60 && d < 60);
  return 0;
}
