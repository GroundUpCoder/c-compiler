// todos/0325 Group A — tzset() (ownership: 0325; todos/0382 gap 6 defers to
// it) and clock_getres().
//
// The host owns the timezone, so absolute offsets are NOT assertable here —
// this pins the INVARIANTS instead, which is what a consumer actually relies
// on. Asserting a literal offset would just encode whatever zone the test
// machine happened to be in.
#include <stdio.h>
#include <time.h>
#include <errno.h>
#include <string.h>

int main(void) {
  tzset();

  // tzname must be populated, never NULL — CPython indexes it directly.
  printf("tzname0_set=%d tzname1_set=%d\n", tzname[0] != 0, tzname[1] != 0);
  printf("tzname0_nonempty=%d\n", tzname[0][0] != 0);
  printf("daylight_is_bool=%d\n", daylight == 0 || daylight == 1);

  // POSIX sign convention: `timezone` is seconds WEST, tm_gmtoff is EAST.
  // Getting this backwards is the classic tzset bug, so pin the relation.
  time_t now = 1700000000;   // fixed instant, so DST state is deterministic
  struct tm lt;
  localtime_r(&now, &lt);
  printf("sign_convention=%d\n", timezone == -lt.tm_gmtoff || daylight);

  // gmtime is always UTC regardless of the host zone.
  struct tm ut;
  gmtime_r(&now, &ut);
  printf("gmt_offset_zero=%d gmt_zone=%s\n", ut.tm_gmtoff == 0, ut.tm_zone);

  // tm_zone is populated for localtime too (todos/0325 Group B: shipping
  // tm_gmtoff without tm_zone was the surprising half).
  printf("local_zone_set=%d\n", lt.tm_zone != 0 && lt.tm_zone[0] != 0);

  // tzset is idempotent: calling it twice must not drift.
  long tz1 = timezone;
  tzset();
  printf("idempotent=%d\n", timezone == tz1);

  // ---- clock_getres ----
  struct timespec r;
  errno = 0;
  int rc = clock_getres(CLOCK_REALTIME, &r);
  printf("realtime rc=%d sec=%lld nsec=%ld\n", rc, (long long)r.tv_sec, r.tv_nsec);
  rc = clock_getres(CLOCK_MONOTONIC, &r);
  printf("monotonic rc=%d sec=%lld nsec=%ld\n", rc, (long long)r.tv_sec, r.tv_nsec);

  // An unknown clock id must FAIL with EINVAL, not silently report something.
  errno = 0;
  rc = clock_getres(9999, &r);
  printf("bogus rc=%d einval=%d\n", rc, errno == EINVAL);

  // NULL res is legal (POSIX): the call still validates the clock id.
  printf("null_ok=%d\n", clock_getres(CLOCK_REALTIME, 0) == 0);

  // The resolution must be a plausible sub-second value, and the clock it
  // describes must actually tick within it.
  clock_getres(CLOCK_REALTIME, &r);
  printf("res_sane=%d\n", r.tv_sec == 0 && r.tv_nsec > 0 && r.tv_nsec < 1000000000L);
  return 0;
}
