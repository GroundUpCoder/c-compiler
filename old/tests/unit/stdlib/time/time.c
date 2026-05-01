#include <time.h>
#include <stdio.h>

int main() {
  /* time() returns non-zero */
  time_t now = time(0);
  printf("time_nonzero: %d\n", now != 0);

  /* time() with pointer */
  time_t t2;
  time(&t2);
  printf("time_ptr: %d\n", t2 != 0);

  /* difftime */
  printf("difftime: %.1f\n", difftime(100, 90));

  /* gmtime on known epoch: 2000-01-01 00:00:00 UTC = 946684800 */
  time_t epoch = 946684800;
  struct tm *gm = gmtime(&epoch);
  printf("gmtime_year: %d\n", gm->tm_year + 1900);
  printf("gmtime_mon: %d\n", gm->tm_mon + 1);
  printf("gmtime_mday: %d\n", gm->tm_mday);
  printf("gmtime_hour: %d\n", gm->tm_hour);
  printf("gmtime_min: %d\n", gm->tm_min);
  printf("gmtime_sec: %d\n", gm->tm_sec);
  printf("gmtime_wday: %d\n", gm->tm_wday);  /* Saturday = 6 */
  printf("gmtime_yday: %d\n", gm->tm_yday);   /* day 0 of year */
  printf("gmtime_isdst: %d\n", gm->tm_isdst);

  /* asctime on known time */
  printf("asctime: %s", asctime(gm));

  /* strftime */
  char buf[64];
  strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", gm);
  printf("strftime: %s\n", buf);
  strftime(buf, sizeof(buf), "%A %B", gm);
  printf("strftime_names: %s\n", buf);
  strftime(buf, sizeof(buf), "%p %j %w %u", gm);
  printf("strftime_misc: %s\n", buf);

  /* mktime round-trip: localtime -> mktime -> localtime should be identity */
  time_t known = 946684800;
  struct tm *lt = localtime(&known);
  struct tm saved;
  saved.tm_year = lt->tm_year;
  saved.tm_mon = lt->tm_mon;
  saved.tm_mday = lt->tm_mday;
  saved.tm_hour = lt->tm_hour;
  saved.tm_min = lt->tm_min;
  saved.tm_sec = lt->tm_sec;
  saved.tm_isdst = lt->tm_isdst;
  time_t roundtrip = mktime(&saved);
  printf("mktime_roundtrip: %d\n", roundtrip == known);

  /* clock() returns non-negative */
  clock_t c = clock();
  printf("clock_nonneg: %d\n", c >= 0);

  return 0;
}
