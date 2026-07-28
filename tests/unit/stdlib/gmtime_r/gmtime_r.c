// todos/0325 Group A — gmtime_r (ownership: 0325; todos/0382 gap 4 defers to
// it, and both tickets record that). Plus the ctime_r/asctime_r twins named
// in the todos/0350 zip-harness gap list.
//
// BEHAVIOUR: fixed epoch seconds in, calendar fields out. Every expected
// value here is host-independent (UTC), so it is clang-verifiable.
#include <stdio.h>
#include <string.h>
#include <time.h>

static void show(const char *tag, time_t t) {
  struct tm tm;
  struct tm *r = gmtime_r(&t, &tm);
  printf("%s %lld -> %04d-%02d-%02d %02d:%02d:%02d wday=%d yday=%d isdst=%d gmtoff=%ld zone=%s same=%d\n",
         tag, (long long)t, tm.tm_year + 1900, tm.tm_mon + 1, tm.tm_mday,
         tm.tm_hour, tm.tm_min, tm.tm_sec, tm.tm_wday, tm.tm_yday,
         tm.tm_isdst, tm.tm_gmtoff, tm.tm_zone ? tm.tm_zone : "(null)",
         r == &tm);
}

int main(void) {
  show("epoch",    0);
  show("y2k",      946684800);
  show("leapday",  951782400);        // 2000-02-29, a century leap year
  show("nonleap",  1078012800);       // 2004-02-29 (ordinary leap year)
  show("pre",      -1);               // 1969-12-31 23:59:59
  show("preday",   -86400);
  show("y2038",    2147483648LL);     // past the 32-bit signed wrap
  show("far",      4102444800LL);     // 2100-01-01, NOT a leap year
  show("dec31",    1735689599);       // 2024-12-31 23:59:59 (leap year, yday 365)

  // The reentrant contract: two live conversions must not share a buffer,
  // which is the entire reason gmtime_r exists. gmtime() cannot do this.
  time_t a = 0, b = 946684800;
  struct tm ta, tb;
  gmtime_r(&a, &ta);
  gmtime_r(&b, &tb);
  printf("independent=%d\n", ta.tm_year == 70 && tb.tm_year == 100);

  // ...whereas the shared-buffer version aliases, as documented.
  struct tm *p1 = gmtime(&a);
  struct tm *p2 = gmtime(&b);
  printf("gmtime_aliases=%d\n", p1 == p2);

  // asctime_r / ctime_r write into the caller's buffer and return it.
  char buf[32];
  struct tm t0;
  time_t z = 0;
  gmtime_r(&z, &t0);
  char *ar = asctime_r(&t0, buf);
  printf("asctime_r=[%s] ret=%d\n", buf, ar == buf);
  return 0;
}
